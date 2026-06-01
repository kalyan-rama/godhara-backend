import express from 'express';

export const apiRouter = express.Router();

// Health Check
apiRouter.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Godhara API Working',
  });
});

// Settings API
apiRouter.get('/settings', async (req, res) => {
  try {
    res.json({
      id: 'global',
      storeName: 'Godhara',
      logoUrl: '/logo.png',
    });
  } catch (error) {
    console.error('[Settings API Error]', error);

    res.status(500).json({
      success: false,
      message: 'Failed to load settings',
    });
  }
});

// Cart API
apiRouter.get('/cart', async (req, res) => {
  try {
    res.json({
      items: [],
    });
  } catch (error) {
    console.error('[Cart API Error]', error);

    res.status(500).json({
      success: false,
      message: 'Failed to load cart',
    });
  }
});

// OTP Send API
apiRouter.post('/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
      });
    }

    // Demo response
    return res.json({
      success: true,
      message: 'OTP sent successfully',
    });
  } catch (error) {
    console.error('[Send OTP Error]', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to send OTP',
    });
  }
});

// OTP Verify API
apiRouter.post('/auth/verify-otp', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        message: 'Email and OTP code are required',
      });
    }

    return res.json({
      success: true,
      message: 'OTP verified successfully',
      token: 'demo-jwt-token',
    });
  } catch (error) {
    console.error('[Verify OTP Error]', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to verify OTP',
    });
  }
});
