FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LEDGER_DATA_DIR=/data
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 10001 --create-home ledger && mkdir /data && chown ledger:ledger /data
COPY --chown=ledger:ledger app.py domain.py ./
COPY --chown=ledger:ledger static ./static
COPY --chown=ledger:ledger templates ./templates
USER ledger
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "1", "--threads", "4", "--timeout", "60", "app:create_app()"]
