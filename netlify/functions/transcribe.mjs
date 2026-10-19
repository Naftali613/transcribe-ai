// Receives an audio file from the app and forwards it to Groq Whisper.
// The API key lives only in Netlify env vars (GROQ_API_KEY) — never in the browser.

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3';

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const key = Netlify.env.get('GROQ_API_KEY');
  if (!key) return json(500, { error: 'מפתח ה-API לא הוגדר בשרת.' });

  let form;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: 'הקובץ לא התקבל כראוי.' });
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') return json(400, { error: 'לא נשלח קובץ.' });

  const lang = form.get('lang') === 'en' ? 'en' : 'he';

  // Groq decides format by extension; WhatsApp voice notes are .opus/.ogg
  let name = file.name || 'audio.ogg';
  if (/\.opus$/i.test(name)) name = name.replace(/\.opus$/i, '.ogg');
  if (!/\.[a-z0-9]{2,4}$/i.test(name)) name += '.ogg';

  const out = new FormData();
  out.append('file', file, name);
  out.append('model', MODEL);
  out.append('language', lang);
  out.append('response_format', 'json');
  out.append('temperature', '0');

  let res;
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: out,
    });
  } catch {
    return json(502, { error: 'שירות התמלול לא זמין כרגע.' });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('Groq error', res.status, detail.slice(0, 500));
    if (res.status === 429) return json(429, { error: 'הגעת למגבלת השימוש החינמית. נסה שוב בעוד כמה דקות.' });
    if (res.status === 413) return json(413, { error: 'הקובץ גדול מדי לתמלול.' });
    return json(502, { error: 'התמלול נכשל. נסה שוב.' });
  }

  const data = await res.json();
  return json(200, { text: (data.text || '').trim() });
};

export const config = { path: '/api/transcribe' };
