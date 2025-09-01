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
# 必要なツール（unzip, wget）をインストールします。
RUN dnf install -y unzip wget && \
    # Lambdaでの動作が確認されている最新のChromiumバイナリ（zip形式）をダウンロードします。
    wget "https://github.com/Sparticuz/chromium/releases/download/v138.0.2/chromium-v138.0.2-layer.x64.zip" -O /tmp/chromium.zip && \
    # /opt ディレクトリに展開します。
    unzip /tmp/chromium.zip -d /opt/ && \
    # 不要な一時ファイルを削除します。
    rm /tmp/chromium.zip && \
    # 不要なキャッシュをクリーンアップします。
    dnf clean all

# ステージ1でビルドしたGoの実行可能ファイルをコピーします。
COPY --from=builder /app/bootstrap /var/runtime/

# Lambdaがこのコンテナを実行する際に呼び出すコマンドを指定します。
CMD [ "bootstrap" ]

