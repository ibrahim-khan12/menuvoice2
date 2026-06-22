// A0: Streaming Edge function — raw SSE passthrough for chat completions.
// Conversation turns send { stream: true }; menu-parsing calls omit it and
// get a buffered JSON response (they need response_format: json_object).
export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const key = process.env.OPENAI_API_KEY;
  if (!key) return Response.json({ error: 'No API key configured on server.' }, { status: 500 });

  let body: any;
  try { body = await req.json(); } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const wantsStream = body?.stream === true;

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!wantsStream) {
    const data = await upstream.json();
    return Response.json(data, { status: upstream.status });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return Response.json({ error: text || 'Upstream error' }, { status: upstream.status || 500 });
  }

  // Raw SSE passthrough — no Node buffering.
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
