FROM golang:1.23-bookworm AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -o /out/vpn-api ./cmd/api && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/vpn-agent-linux-amd64 ./cmd/agent && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o /out/vpn-agent-linux-arm64 ./cmd/agent

FROM debian:bookworm-slim AS runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates openvpn easy-rsa sqlite3 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/vpn-api
RUN mkdir -p /opt/vpn-api/bin /opt/vpn-api/data /opt/vpn-api/ca /opt/vpn-api/scripts

COPY --from=builder /out/vpn-api /opt/vpn-api/bin/vpn-api
COPY --from=builder /out/vpn-agent-linux-amd64 /opt/vpn-api/bin/vpn-agent-linux-amd64
COPY --from=builder /out/vpn-agent-linux-arm64 /opt/vpn-api/bin/vpn-agent-linux-arm64
COPY scripts/backup.sh /opt/vpn-api/scripts/backup.sh
COPY scripts/node-setup.sh /opt/vpn-api/scripts/node-setup.sh

RUN chmod +x /opt/vpn-api/bin/vpn-api /opt/vpn-api/bin/vpn-agent-linux-amd64 /opt/vpn-api/bin/vpn-agent-linux-arm64 /opt/vpn-api/scripts/backup.sh /opt/vpn-api/scripts/node-setup.sh

ENV API_PORT=56700 \
    DB_DRIVER=sqlite \
    DB_PATH=/opt/vpn-api/data/vpn.db \
    JWT_SECRET=change-this-secret \
    CA_DIR=/opt/vpn-api/ca \
    EXTERNAL_URL=http://127.0.0.1:56700 \
    VPN_AGENT_BIN_DIR=/opt/vpn-api/bin

EXPOSE 56700
VOLUME ["/opt/vpn-api/data", "/opt/vpn-api/ca", "/opt/vpn-api/backups"]

ENTRYPOINT ["/opt/vpn-api/bin/vpn-api"]
