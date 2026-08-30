import type { VercelRequest, VercelResponse } from '@vercel/node';

// Apple's "Sign in with Apple" web flow POSTs the result to the registered
// redirect_uri (response_mode=form_post is required whenever an id_token is
// requested) — unlike Google's implicit flow, the token never lands in a URL
// fragment a static page could read. This endpoint exists only to receive
// that POST and hand the token to the native app through its custom URL
// scheme, the same way oauth-callback.html does for Google's fragment-based
// redirect.
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = (req.body ?? {}) as { id_token?: string; state?: string; error?: string };
  const params = new URLSearchParams();
  if (body.id_token) params.set('id_token', body.id_token);
  if (body.state) params.set('state', body.state);
  if (body.error) params.set('error', body.error);
  const redirectUrl = `com.meetmymenu.app://apple-oauth-callback#${params.toString()}`;
  res.setHeader('Content-Type', 'text/html');
  // A meta-refresh + JS redirect (not a 302) because some in-app/system
  // browser contexts don't reliably follow a server redirect to a custom
  // scheme, but do follow a same-document navigation.
  return res.status(200).send(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Signing in&hellip;</title></head>` +
    `<body><p>Signing in&hellip;</p><script>window.location.replace(${JSON.stringify(redirectUrl)});</script></body></html>`,
  );
}
