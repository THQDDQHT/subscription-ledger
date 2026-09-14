"""本机启动入口：uv run serve.py [端口]。仅监听 127.0.0.1，Ctrl-C 停止。"""
import sys
from gunicorn.app.base import BaseApplication
from app import create_app


class Server(BaseApplication):
    def load_config(self):
        port = sys.argv[1] if len(sys.argv) > 1 else '8765'
        for key, value in {'bind': f'127.0.0.1:{port}', 'workers': 1, 'threads': 4, 'timeout': 60}.items():
            self.cfg.set(key, value)

    def load(self):
        return create_app()


if __name__ == '__main__':
    print('订阅账本已启动：http://' + (Server().cfg.bind[0]), flush=True)
    Server().run()
