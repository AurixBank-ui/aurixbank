const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();
const db = admin.firestore();

// Configure email transport
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'aurixbank@gmail.com',
    pass: 'SafeHaven@72'
  }
});

const ADMIN_EMAIL = 'aurixbank@gmail.com';

/**
 * Triggered when a new registration is submitted.
 * Sends an OTP to the admin's email for approval.
 */
exports.onNewRegistration = functions.firestore
  .document('pendingRegistrations/{regId}')
  .onCreate(async (snap, context) => {
    const data = snap.data();
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store the OTP in the registration document
    await snap.ref.update({ approvalOtp: otp, status: 'pending' });

    const mailOptions = {
      from: '"Aurix Bank Admin" <aurixbank@gmail.com>',
      to: ADMIN_EMAIL,
      subject: 'New Registration Request - Aurix Bank',
      html: `
        <h3>New User Registration</h3>
        <p><strong>Name:</strong> ${data.firstName} ${data.lastName}</p>
        <p><strong>Email:</strong> ${data.email}</p>
        <p>To approve this user, use the following OTP in the Admin Portal:</p>
        <h2 style="color: #8FADCB; letter-spacing: 5px;">${otp}</h2>
        <p>If you don't recognize this request, you can safely ignore this email.</p>
      `
    };

    return transporter.sendMail(mailOptions);
  });

/**
 * Send Admin OTP for Portal Login
 */
exports.sendAdminOtp = functions.https.onCall(async (data, context) => {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Date.now() + (10 * 60 * 1000); // 10 minutes

  await db.collection('adminLoginTokens').doc(ADMIN_EMAIL).set({
    otp,
    expires,
    email: ADMIN_EMAIL
  });

  const mailOptions = {
    from: '"Aurix Bank Security" <aurixbank@gmail.com>',
    to: ADMIN_EMAIL,
    subject: 'Admin Portal Access Code',
    html: `
      <h3>Security Verification</h3>
      <p>Use the following code to access the Aurix Bank Admin Portal:</p>
      <h2 style="color: #8FADCB; letter-spacing: 5px;">${otp}</h2>
      <p>This code will expire in 10 minutes.</p>
    `
  };

  await transporter.sendMail(mailOptions);
  return { success: true };
});

/**
 * Verify Admin OTP for Portal Login
 */
exports.verifyAdminOtp = functions.https.onCall(async (data, context) => {
  const { otp } = data;
  const doc = await db.collection('adminLoginTokens').doc(ADMIN_EMAIL).get();

  if (!doc.exists) return { success: false, message: 'No token found' };

  const tokenData = doc.data();
  if (tokenData.otp === otp && Date.now() < tokenData.expires) {
    // Clear the token after use
    await doc.ref.delete();
    return { success: true };
  }

  return { success: false, message: 'Invalid or expired OTP' };
});

/**
 * Admin action: Approve Registration
 * REQUIREMENT 1: User gets assigned balance immediately upon approval
 */
exports.approveRegistration = functions.https.onCall(async (data, context) => {
  // Check if caller is the admin
  if (context.auth.token.email !== ADMIN_EMAIL) {
    throw new functions.https.HttpsError('permission-denied', 'Unauthorized');
  }

  const { regId, initialBalance } = data;
  const regSnap = await db.collection('pendingRegistrations').doc(regId).get();

  if (!regSnap.exists) throw new functions.https.HttpsError('not-found', 'Registration not found');
  const regData = regSnap.data();

  try {
    // 1. Create the Firebase Auth user
    const userRecord = await admin.auth().createUser({
      email: regData.email,
      password: regData.password,
      displayName: `${regData.firstName} ${regData.lastName}`
    });

    // 2. Create the Firestore user document
    await db.collection('users').doc(userRecord.uid).set({
      firstName: regData.firstName,
      lastName: regData.lastName,
      email: regData.email,
      phone: regData.phone || '',
      isAdmin: false,
      isFlagged: false,
      customBankName: 'Aurix Bank', // REQUIREMENT 2: Default name is "Aurix Bank"
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 3. Create the accounts document with initial balance (REQUIREMENT 1: Immediate assignment)
    await db.collection('accounts').doc(userRecord.uid).set({
      checkingBalance: parseFloat(initialBalance) || 0,
      savingsBalance: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4. Initialize empty transactions
    await db.collection('transactions').doc(userRecord.uid).set({ items: [] });

    // 5. Mark registration as approved
    await regSnap.ref.update({ 
      status: 'approved', 
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: ADMIN_EMAIL
    });

    return { success: true, uid: userRecord.uid };
  } catch (error) {
    console.error(error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});
