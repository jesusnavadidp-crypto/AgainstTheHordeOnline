# Local dev server for the Horde table: serves this folder with caching off,
# so a browser refresh always picks up the latest code.
# Usage: python3 serve.py [port]   (default 5173)
import http.server, os, sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
print(f'Horde table on http://localhost:{port}')
http.server.ThreadingHTTPServer(('', port), NoCache).serve_forever()
