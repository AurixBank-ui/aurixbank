// api/verify-cheque.js
// Called from chequedeposit.html when the user uploads a cheque image.
// Sends the image to Claude claude-sonnet-4-6 vision and returns whether it looks
// like a legitimate bank cheque.
//
// Add this to your Vercel environment variables:
//   ANTHROPIC_API_KEY = your Anthropic API key (from console.anthropic.com)

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imageBase64, mediaType } = req.body;

  if (!imageBase64 || !mediaType) {
    return res.status(400).json({ error: 'Missing imageBase64 or mediaType' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured in Vercel environment variables.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: imageBase64
                }
              },
              {
                type: 'text',
                text: `Examine this image carefully. Does it appear to be a legitimate bank cheque (check)?

A legitimate cheque typically contains most of these elements:
- A bank name and/or logo
- A "Pay to the order of" line
- A written or numeric dollar amount
- A date field
- A signature line
- MICR numbers at the bottom (routing and account numbers)
- Cheque number

Respond with ONLY a valid JSON object and nothing else. No markdown, no explanation outside the JSON:
{"isCheck": true or false, "reason": "one sentence explaining what you see and why it is or isn't a cheque"}`
              }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(502).json({ error: 'Image analysis failed. Try again.' });
    }

    const data = await response.json();
    const raw = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Strip markdown fences if the model adds them
    const clean = raw.replace(/```json|```/g, '').trim();

    let result;
    try {
      result = JSON.parse(clean);
    } catch {
      // If the model returns something unparseable, fail safe
      console.error('Could not parse model response:', raw);
      result = { isCheck: false, reason: 'Could not analyse this image. Please upload a clear photo of a cheque.' };
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('verify-cheque handler error:', err);
    return res.status(500).json({ error: 'Internal server error. Try again.' });
  }
}