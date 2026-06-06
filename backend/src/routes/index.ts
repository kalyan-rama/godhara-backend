if (token) {
    jwt.verify(token, JWT_SECRET, (err, userPayload: any) => {
      if (err) {
        const reason = `JWT verification failed: ${err.message}`;
        console.warn(`[401 UNAUTHORIZED INTERCEPT] Route: "${currentRoute}", UserID: "N/A", Email: "N/A", Role: "N/A", OTP_Verified: "N/A", Denial Reason: "${reason}"`);
        return res.status(401).json({ message: 'Invalid or expired signature', error: err.message });
      }

      req.user = {
        id: userPayload.id,
        email: userPayload.email,
        role: userPayload.role,
        otpVerified: !!userPayload.otpVerified
      };

      console.log('[Auth Decision Log] JWT Verification success. User:', req.user);

      if (req.session) {
        (req.session as any).user = {
          id: req.user.id,
          email: req.user.email,
          role: req.user.role,
          otpVerified: req.user.otpVerified
        };
      }

      return next();
    });               // ← closes jwt.verify callback
    return;           // ← exits the if(token) block; prevents fall-through
  }

  // 3. Session fallback — only reached when NO Bearer token was present
  if ((req.session as any)?.user) {
    req.user = (req.session as any).user;

    console.log(
      '[Auth Decision Log] Authenticated via session fallback user:',
      req.user
    );

    return next();
  }

  // 4. Nothing matched — reject
  const reason = 'Authentication required but missing Bearer token or active Session state in headers/cookies';
  console.warn(`[401 UNAUTHORIZED INTERCEPT] Route: "${currentRoute}", UserID: "N/A", Email: "N/A", Role: "N/A", OTP_Verified: "N/A", Denial Reason: "${reason}"`);
  return res.status(401).json({ message: 'Authentication required. Unauthorized.', error: 'UNAUTHENTICATED' });
}
