export interface SseEvent {
  event?: string;
  data: string;
}

// Minimal server-sent events parser: events are separated by a blank line, fields are "name: value".
// Chunks from the network can split an event anywhere, so text is buffered until a separator arrives.
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  const parse = (block: string): SseEvent | null => {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const ev = parse(buffer.slice(0, sep));
      buffer = buffer.slice(sep + 2);
      if (ev) yield ev;
    }
  }
  const tail = parse(buffer + decoder.decode());
  if (tail) yield tail;
}
