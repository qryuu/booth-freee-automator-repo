# このDockerfileは、AWS CodeBuildで実行することを前提としています。
# ------------------------------------------------------------------------------
# 最終コマンド (PowerShellから実行):
# docker buildx build --platform linux/amd64 -t YOUR_AWS_ACCOUNT_ID.dkr.ecr.ap-northeast-1.amazonaws.com/booth-freee-automator:v8.0-cloudbuild --push .
# ------------------------------------------------------------------------------

# --- ステージ1: ビルド環境 ---
# Amazon Linux 2023をベースに、Go言語とGitをインストールします。
FROM public.ecr.aws/lambda/provided:al2023 as builder

# GoとGitをインストール
RUN dnf install -y golang git

# アプリケーションのソースコードをコピー
WORKDIR /app
COPY main.go .

# 依存関係をダウンロードし、ビルドを実行
RUN go mod init main && \
    go get github.com/chromedp/chromedp && \
    go get github.com/aws/aws-lambda-go/lambda
RUN go build -o bootstrap main.go


# --- ステージ2: 実行環境 ---
# Lambdaの実行に必要な最小限の環境を作成します。
FROM public.ecr.aws/lambda/provided:al2023

# Google Chromeの公式リポジトリ設定を直接書き込みます。
# これにより、ネットワークの状態に左右されず、安定してインストールできます。
RUN printf "[google-chrome]\nname=google-chrome\nbaseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64\nenabled=1\ngpgcheck=1\ngpgkey=https://dl.google.com/linux/linux_signing_key.pub" > /etc/yum.repos.d/google-chrome.repo

# パッケージリストを更新してから、Chromeとフォントをインストールします。
# これにより、パッケージの依存関係の問題やロックの競合を防ぎます。
RUN dnf update -y && \
    dnf install -y google-chrome-stable liberation-sans-fonts && \
    dnf clean all

# ビルドステージからコンパイル済みのGoプログラムをコピー
COPY --from=builder /app/bootstrap /var/runtime/

# Lambdaが実行するコマンドを設定
CMD [ "bootstrap" ]

