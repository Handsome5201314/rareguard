FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --uid 10001 --create-home rareguard
USER rareguard
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "18080", "--no-access-log"]
