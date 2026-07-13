const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();
const db = admin.firestore();

const ADMIN_EMAIL = 'aurixbank@gmail.com';

// Gmail credential lives in Secret Manager now — never in source. Set it with:
//   firebase functions:secrets:set GMAIL_APP_PASSWORD
// Use a Gmail "App Password" here, not your real account password. Generate
// one at https://myaccount.google.com/apppasswords (requires 2-Step
// Verification to be turned on for the Gmail account).
const GMAIL_APP_PASSWORD_SECRET = ['GMAIL_APP_PASSWORD'];

// Built lazily inside each handler (not at module load) so the secret is
// guaranteed to be populated by the time it's read.
function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: ADMIN_EMAIL,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

// Throws unless the caller is authenticated AND is the admin account.
// Every admin-only callable function starts with this.
function requireAdmin(context) {
  if (!context.auth || context.auth.token.email !== ADMIN_EMAIL) {
    throw new functions.https.HttpsError('permission-denied', 'Admin access only.');
  }
}

/**
 * Triggered when a new registration is submitted.
 * Sends an OTP to the admin's email for approval.
 */
exports.onNewRegistration = functions
  .runWith({ secrets: GMAIL_APP_PASSWORD_SECRET })
  .firestore.document('pendingRegistrations/{regId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await snap.ref.update({ approvalOtp: otp, status: 'pending' });

    const mailOptions = {
      from: `"Aurix Bank Admin" <${ADMIN_EMAIL}>`,
      to: ADMIN_EMAIL,
      subject: 'New Registration Request - Aurix Bank',
      html: `
        <h3>New User Registration</h3>
        <p><strong>Name:</strong> ${data.firstName} ${data.lastName}</p>
        <p><strong>Email:</strong> ${data.email}</p>
        <p>Review and approve or reject this request in the Admin Portal.</p>
      `
    };

    return getTransporter().sendMail(mailOptions);
  });

/**
 * Send Admin OTP for Portal Login.
 * Caller must already be signed in as the admin Firebase Auth account —
 * the password check itself happens client-side via signInWithEmailAndPassword,
 * which is verified server-side by Firebase Auth, not by comparing strings
 * in the browser.
 */
exports.sendAdminOtp = functions
  .runWith({ secrets: GMAIL_APP_PASSWORD_SECRET })
  .https.onCall(async (data, context) => {
    requireAdmin(context);

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + (10 * 60 * 1000); // 10 minutes

    await db.collection('adminLoginTokens').doc(ADMIN_EMAIL).set({
      otp,
      expires,
      email: ADMIN_EMAIL
    });

    const mailOptions = {
      from: `"Aurix Bank Security" <${ADMIN_EMAIL}>`,
      to: ADMIN_EMAIL,
      subject: 'Admin Portal Access Code',
      html: `
        <h3>Security Verification</h3>
        <p>Use the following code to access the Aurix Bank Admin Portal:</p>
        <h2 style="color: #8FADCB; letter-spacing: 5px;">${otp}</h2>
        <p>This code will expire in 10 minutes.</p>
      `
    };

    await getTransporter().sendMail(mailOptions);
    return { success: true };
  });

/**
 * Verify Admin OTP for Portal Login
 */
exports.verifyAdminOtp = functions.https.onCall(async (data, context) => {
  requireAdmin(context);

  const { otp } = data;
  const tokenDoc = await db.collection('adminLoginTokens').doc(ADMIN_EMAIL).get();

  if (!tokenDoc.exists) return { success: false, message: 'No token found' };

  const tokenData = tokenDoc.data();
  if (tokenData.otp === otp && Date.now() < tokenData.expires) {
    await tokenDoc.ref.delete();
    return { success: true };
  }

  return { success: false, message: 'Invalid or expired OTP' };
});

/**
 * Admin action: Approve Registration.
 * Creates the real Firebase Auth account + starting Firestore documents,
 * then strips the plaintext password from the pending registration record
 * so it doesn't sit around in Firestore any longer than necessary.
 */
exports.approveRegistration = functions.https.onCall(async (data, context) => {
  requireAdmin(context);

  const { regId, initialBalance } = data;
  const regSnap = await db.collection('pendingRegistrations').doc(regId).get();

  if (!regSnap.exists) throw new functions.https.HttpsError('not-found', 'Registration not found');
  const regData = regSnap.data();

  if (regData.status === 'approved') {
    throw new functions.https.HttpsError('failed-precondition', 'This registration was already approved.');
  }

  try {
    const userRecord = await admin.auth().createUser({
      email: regData.email,
      password: regData.password,
      displayName: `${regData.firstName} ${regData.lastName}`
    });

    await db.collection('users').doc(userRecord.uid).set({
      firstName: regData.firstName,
      lastName: regData.lastName,
      email: regData.email,
      phone: regData.phone || '',
      isAdmin: false,
      isFlagged: false,
      customBankName: 'Aurix Bank',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('accounts').doc(userRecord.uid).set({
      checkingBalance: parseFloat(initialBalance) || 0,
      savingsBalance: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('transactions').doc(userRecord.uid).set({ items: [] });

    // Mark approved and remove the plaintext password now that the real
    // (hashed, Firebase-Auth-managed) account has been created from it.
    await regSnap.ref.update({
      status: 'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: ADMIN_EMAIL,
      password: admin.firestore.FieldValue.delete()
    });

    return { success: true, uid: userRecord.uid };
  } catch (error) {
    console.error(error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

/**
 * Admin action: Reject Registration.
 * Marks the pending request as rejected and removes the plaintext password
 * immediately, since no account will ever be created from it.
 */
exports.rejectRegistration = functions.https.onCall(async (data, context) => {
  requireAdmin(context);

  const { regId, reason } = data;
  const regSnap = await db.collection('pendingRegistrations').doc(regId).get();
  if (!regSnap.exists) throw new functions.https.HttpsError('not-found', 'Registration not found');

  await regSnap.ref.update({
    status: 'rejected',
    rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
    rejectedBy: ADMIN_EMAIL,
    rejectionReason: reason || '',
    password: admin.firestore.FieldValue.delete()
  });

  return { success: true };
});

/**
 * Admin action: Delete an approved user's account entirely.
 * Removes the Firebase Auth account and every Firestore document tied to
 * that uid across all collections the app uses.
 */
exports.deleteUserAccount = functions.https.onCall(async (data, context) => {
  requireAdmin(context);

  const { uid } = data;
  if (!uid) throw new functions.https.HttpsError('invalid-argument', 'Missing uid.');

  const collectionsToClean = [
    'users', 'accounts', 'transactions', 'cards',
    'scheduledTransfers', 'chequeDeposits', 'loanApplications', 'loginHistory'
  ];

  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    // If the Auth user is already gone, still clean up Firestore rather than
    // stopping halfway — but surface anything else.
    if (error.code !== 'auth/user-not-found') {
      console.error(error);
      throw new functions.https.HttpsError('internal', error.message);
    }
  }

  const batch = db.batch();
  collectionsToClean.forEach(col => {
    batch.delete(db.collection(col).doc(uid));
  });
  await batch.commit();

  return { success: true };
});