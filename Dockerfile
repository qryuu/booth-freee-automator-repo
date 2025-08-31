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

# ★★★ The Final Solution ★★★
# Lambdaでの動作が確認されているChromiumバイナリを直接ダウンロードして使用します。
RUN dnf install -y tar && \
    # Lambda互換のChromiumバイナリをダウンロードします。
    curl -Lo /tmp/chromium.tar "https://github.com/Sparticuz/chromium/releases/download/v123.0.1/chromium-v123.0.1-pack.tar" && \
    # /opt ディレクトリに展開します。
    tar -xvf /tmp/chromium.tar -C /opt && \
    # 展開されたディレクトリ内の実行ファイルを正しいパスに移動させます。
    mv /opt/pack/chromium /opt/chromium && \
    # 不要なディレクトリとファイルを削除します。
    rm -rf /opt/pack && \
    rm /tmp/chromium.tar && \
    # 不要なキャッシュをクリーンアップします。
    dnf clean all

# ステージ1でビルドしたGoの実行可能ファイルをコピーします。
COPY --from=builder /app/bootstrap /var/runtime/

# Lambdaがこのコンテナを実行する際に呼び出すコマンドを指定します。
CMD [ "bootstrap" ]

