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

# ★★★ The Final Solution (from blog post) ★★★
# 必要なツールをインストールします。
RUN dnf install -y curl bzip2 && \
    # Lambda互換のChromiumバイナリ（bz2形式）をダウンロードします。
    curl -L https://github.com/shelfio/chrome-aws-lambda-layer/releases/download/v33/headless-chromium.tar.bz2 -o /tmp/chromium.tar.bz2 && \
    # /opt ディレクトリに正しく解凍します。
    tar -xjvf /tmp/chromium.tar.bz2 -C /opt/ && \
    # 不要なファイルを削除します。
    rm /tmp/chromium.tar.bz2 && \
    # 不要なキャッシュをクリーンアップします。
    dnf clean all

# ステージ1でビルドしたGoの実行可能ファイルをコピーします。
COPY --from=builder /app/bootstrap /var/runtime/

# Lambdaがこのコンテナを実行する際に呼び出すコマンドを指定します。
CMD [ "bootstrap" ]

