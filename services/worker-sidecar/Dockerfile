# worker sidecar：多阶段构建，运行时仅含静态二进制（distroless 静态镜像，非 root）。
# 构建镜像须与 go.mod 的 go 指令对齐（低版本在 GOTOOLCHAIN=auto 下会
# 静默下载新工具链、=local 下直接构建失败；CI 侧同见 .github/workflows/ci.yml）。
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/worker-sidecar .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/worker-sidecar /worker-sidecar
USER nonroot:nonroot
EXPOSE 8082
ENTRYPOINT ["/worker-sidecar"]
