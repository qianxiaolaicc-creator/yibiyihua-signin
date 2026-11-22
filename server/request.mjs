export class HttpError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export function fail(status, message, data) {
  throw new HttpError(status, message, data);
}

export async function readJson(request, maxBytes) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail(415, '请使用 JSON 请求。');
  }
  if (Number(request.headers.get('content-length')) > maxBytes) fail(413, '提交内容过大。');
  if (!request.body) fail(400, '提交内容格式不正确。');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      fail(413, '提交内容过大。');
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    const data = JSON.parse(text + decoder.decode());
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    fail(400, '提交内容格式不正确。');
  }
  fail(400, '提交内容格式不正确。');
}
