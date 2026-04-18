User: Can you help me refactor the auth flow in my project? I want to move from session cookies to JWTs.

Claude: Happy to help. Before we start, a few questions so I don't accidentally break things:

1. Where is the session middleware wired up — is it one express app or multiple?
2. Do you have a mobile client that talks to the same API, or is it web-only?
3. Is token rotation something you already need, or can we start with long-lived tokens?

User: It's one express app, web-only for now, and yeah let's start simple — no rotation. Assume we'll add it later.

Claude: Got it. Here's the plan:

1. Replace `express-session` with a lightweight JWT middleware (jose or jsonwebtoken).
2. Move login to issue a signed token instead of setting a cookie. Return it in the response body.
3. Update the frontend to store the token (localStorage for now, httpOnly cookie later when we revisit rotation).
4. Keep `/logout` but make it a no-op server-side — clients just drop the token.

Does this plan match what you had in mind, or do you want me to keep the cookie as a fallback?

User: Plan matches. One thing — can we keep the `/me` endpoint working the same way? I don't want to update every component.

Claude: Yes, that's straightforward. The `/me` handler just needs to read `req.user` from the JWT middleware instead of `req.session.user`. The response shape stays identical, so the frontend doesn't change.

Want me to start with the middleware swap first, or the login endpoint?

User: Middleware first. Show me the diff before you run anything.

Claude: Here's the middleware diff. Nothing runs yet — just review:

```diff
- app.use(session({ secret: process.env.SESSION_SECRET, ... }));
+ import { jwtVerify } from 'jose';
+ app.use(async (req, res, next) => {
+   const token = req.headers.authorization?.replace(/^Bearer /, '');
+   if (!token) return next();
+   try {
+     const { payload } = await jwtVerify(token, JWT_SECRET);
+     req.user = payload;
+   } catch {
+     // invalid token → treat as unauthenticated
+   }
+   next();
+ });
```

User: Looks good. Apply it.
