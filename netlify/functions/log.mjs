// Receives small anonymous diagnostic reports from the app (no audio, no text)
// and writes them to the function log, so share problems can be traced.
export default async (req) => {
  if (req.method !== 'POST') return new Response('', { status: 405 });
  let body = '';
  try { body = (await req.text()).slice(0, 2000); } catch {}
  console.log('[diag]', body);
  return new Response('', { status: 204 });
};

export const config = { path: '/api/log' };
