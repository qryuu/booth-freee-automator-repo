# -------------------------------------------------------------------------------------
# -- ステージ1: ビルド環境 --
# -------------------------------------------------------------------------------------
FROM public.ecr.aws/lambda/provided:al2023 as builder

RUN dnf install -y golang git

WORKDIR /app
COPY main.go .

RUN go mod init main && \
    go get github.com/chromedp/chromedp && \
    go get github.com/aws/aws-lambda-go/lambda

RUN CGO_ENABLED=0 go build -o bootstrap main.go

# -------------------------------------------------------------------------------------
# -- ステージ2: 最終的な実行イメージ --
# -------------------------------------------------------------------------------------
FROM public.ecr.aws/lambda/provided:al2023

# ★★★ The Final Definitive Solution ★★★
# 必要なツール（brotli, tar, wget）をインストールします。
RUN dnf install -y brotli tar wget && \
    # wgetを使用して、より堅牢な方法でChromiumバイナリをダウンロードします。
    wget "https://github.com/Sparticuz/chromium/releases/download/v123.0.1/chromium-v123.0.1-al2023.tar.br" -O /tmp/chromium.tar.br && \
    # 一時ファイルに解凍します。
    brotli -d /tmp/chromium.tar.br -o /tmp/chromium.tar && \
    # 解凍したtarファイルを展開します。
    tar -xvf /tmp/chromium.tar -C /opt/ && \
    # 不要な一時ファイルを削除します。
    rm /tmp/chromium.tar.br /tmp/chromium.tar && \
    # 不要なキャッシュをクリーンアップします。
    dnf clean all

# ステージ1でビルドしたGoの実行可能ファイルをコピーします。
COPY --from=builder /app/bootstrap /var/runtime/

# Lambdaがこのコンテナを実行する際に呼び出すコマンドを指定します。
CMD [ "bootstrap" ]

