// ==Cloudflare Pages Function — VLESS over XHTTP==
// path: functions/vless.js

import { connect } from "cloudflare:sockets";

const UUID = "85b76291-de0e-4d49-b1c0-1faaadc0bb28";

function parseUUID(uuid) {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function uuidEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function parseVlessHeader(buffer) {
  const view = new DataView(buffer);
  let offset = 0;

  const version = view.getUint8(offset++);
  const uuidBytes = new Uint8Array(buffer, offset, 16);
  offset += 16;

  const addonLength = view.getUint8(offset++);
  offset += addonLength;

  const command = view.getUint8(offset++);
  if (command !== 1) throw new Error(`Unsupported command: ${command}`);

  const port = view.getUint16(offset);
  offset += 2;

  const addrType = view.getUint8(offset++);
  let address = "";

  if (addrType === 1) {
    address = Array.from(new Uint8Array(buffer, offset, 4)).join(".");
    offset += 4;
  } else if (addrType === 2) {
    const domainLen = view.getUint8(offset++);
    address = new TextDecoder().decode(new Uint8Array(buffer, offset, domainLen));
    offset += domainLen;
  } else if (addrType === 3) {
    const ipv6 = new Uint8Array(buffer, offset, 16);
    const parts = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(((ipv6[i] << 8) | ipv6[i + 1]).toString(16));
    }
    address = parts.join(":");
    offset += 16;
  } else {
    throw new Error(`Unknown address type: ${addrType}`);
  }

  return { version, uuidBytes, port, address, headerLength: offset };
}

async function handleVless(request) {
  const body = await request.arrayBuffer();

  let parsed;
  try {
    parsed = parseVlessHeader(body);
  } catch (e) {
    return new Response(`Bad VLESS header: ${e.message}`, { status: 400 });
  }

  if (!uuidEqual(parsed.uuidBytes, parseUUID(UUID))) {
    return new Response("Unauthorized", { status: 403 });
  }

  const { version, address, port, headerLength } = parsed;
  const payload = body.slice(headerLength);

  let tcpSocket;
  try {
    tcpSocket = connect({ hostname: address, port });
  } catch (e) {
    return new Response(`Connect failed: ${e.message}`, { status: 502 });
  }

  const writer = tcpSocket.writable.getWriter();
  if (payload.byteLength > 0) {
    await writer.write(new Uint8Array(payload));
  }
  writer.releaseLock();

  const vlessResponseHeader = new Uint8Array([version, 0]);
  let headerSent = false;

  const { readable, writable } = new TransformStream();
  const responseWriter = writable.getWriter();

  (async () => {
    const reader = tcpSocket.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!headerSent) {
          const combined = new Uint8Array(vlessResponseHeader.length + value.length);
          combined.set(vlessResponseHeader, 0);
          combined.set(value, vlessResponseHeader.length);
          await responseWriter.write(combined);
          headerSent = true;
        } else {
          await responseWriter.write(value);
        }
      }
    } catch (e) {
      console.error("[pages] Stream error:", e.message);
    } finally {
      responseWriter.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

// Pages Functions export
export async function onRequestPost(context) {
  return handleVless(context.request);
}

export async function onRequestGet(context) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OK</title></head>
     <body style="font-family:monospace;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
     <p>OK</p></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
