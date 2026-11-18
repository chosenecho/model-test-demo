"""本地假上游：/anthropic/v1/files + /anthropic/v1/messages（SSE）+ /models。"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

SSE = (
    'event: message_start\n'
    'data: {"type":"message_start","message":{"id":"msg_mock","usage":{"input_tokens":1000,"output_tokens":1}}}\n\n'
    'event: message_delta\n'
    'data: {"type":"message_delta","usage":{"output_tokens":200}}\n\n'
    'event: message_stop\n'
    'data: {"type":"message_stop"}\n\n'
)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _read_body(self):
        return self.rfile.read(int(self.headers.get('content-length') or 0))

    def _send(self, body: bytes, ctype: str, status: int = 200):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('content-length') or 0)
        body = self._read_body()
        if '/anthropic/v1/files' in self.path:
            payload = {
                'id': 'file_mock_1',
                'type': 'file',
                'size_bytes': length,
                'created_at': '2026-11-17T12:00:00Z',
                'filename': 'mock.pdf',
                'mime_type': 'application/pdf',
            }
            self._send(json.dumps(payload).encode(), 'application/json')
            return
        self._send(SSE.encode(), 'text/event-stream')

    def do_DELETE(self):
        self._send(b'{"deleted":true}', 'application/json')

    def do_GET(self):
        self._send(json.dumps({'data': [{'id': 'deepseek-flash', 'type': 'model'}]}).encode(), 'application/json')

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8789
    HTTPServer(('127.0.0.1', port), Handler).serve_forever()
