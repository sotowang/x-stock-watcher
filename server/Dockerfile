FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /relay .

FROM alpine:3.22
RUN addgroup -S relay && adduser -S relay -G relay
WORKDIR /app
COPY --from=build /relay /usr/local/bin/relay
RUN mkdir /app/data && chown -R relay:relay /app
USER relay
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/relay"]
