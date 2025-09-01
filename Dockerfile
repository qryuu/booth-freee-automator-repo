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
    # 最新のChromiumパックファイルをダウンロードします。
    wget "https://github.com/Sparticuz/chromium/releases/download/v138.0.2/chromium-v138.0.2-pack.x64.tar" -O /tmp/chromium-pack.tar && \
    # お客様に特定していただいた、正しいハッシュ値を検証します。
    echo "e083d21c5db6b93a0806d284a75e02dadfcd2cfe17aec8d9b25a56f8716e6235  /tmp/chromium-pack.tar" | sha256sum -c - && \
    # 一時ディレクトリを作成し、パックファイルを展開します。
    mkdir /tmp/pack-contents && \
    tar -xvf /tmp/chromium-pack.tar -C /tmp/pack-contents && \
    # パックの中からAmazon Linux 2023用のバイナリを展開します。
    brotli -d /tmp/pack-contents/al2023.tar.br | tar -x -C /opt/ && \
    # 不要な一時ファイルを削除します。
    rm -rf /tmp/chromium-pack.tar /tmp/pack-contents && \
    # 不要なキャッシュをクリーンアップします。
    dnf clean all

# ステージ1でビルドしたGoの実行可能ファイルをコピーします。
COPY --from=builder /app/bootstrap /var/runtime/

# Lambdaがこのコンテナを実行する際に呼び出すコマンドを指定します。
CMD [ "bootstrap" ]

