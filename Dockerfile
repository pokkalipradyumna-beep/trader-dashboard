# Trader Dashboard — Python standard library only, no build step, no pip installs.
FROM python:3.12-slim

WORKDIR /app
COPY . .

# Host platforms (Render/Railway/Fly) inject $PORT; HOST 0.0.0.0 binds all interfaces.
ENV HOST=0.0.0.0 PORT=8787 PYTHONUNBUFFERED=1
EXPOSE 8787

# Simple container healthcheck hits the /healthz route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/healthz'%os.environ.get('PORT','8787'),timeout=4)" || exit 1

CMD ["python", "server.py"]
