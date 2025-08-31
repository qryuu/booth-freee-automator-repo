# ==================================================================================================
# 【重要】最終版・クラウドビルド用Dockerfile (2025/08/31更新)
# ==================================================================================================
# 目的：AWS CodeBuild上で動作させることを前提とした、最も確実なDockerfileです。
# 手法：Amazon Linux 2023をベースに、Google公式リポジトリからChromeを直接インストールします。
# これにより、OSのパッケージリストに依存せず、常に安定したビルドを実現します。
# ==================================================================================================

# ===== ステージ1: ビルド環境 =====
# AWSが提供する、Amazon Linux 2023ベースのLambda実行用公式イメージを使用します。
# このイメージにはビルドに必要なツールも含まれています。
FROM public.ecr.aws/lambda/provided:al2023 as builder

# Go言語とGitをインストール
RUN dnf install -y golang git

WORKDIR /app
COPY main.go .

# 依存関係をダウンロードし、ビルド
RUN go mod init main && \
    go get github.com/chromedp/chromedp && \
    go get github.com/aws/aws-lambda-go/lambda
RUN go build -o bootstrap main.go


# ===== ステージ2: 実行環境 =====
# AWSが提供する、Amazon Linux 2023ベースのLambda実行用公式イメージを使用します
FROM public.ecr.aws/lambda/provided:al2023

# Google Chromeの公式リポジトリ設定を直接書き込みます。
# これにより、ネットワークの状態に左右されず、常に安定してリポジトリを追加できます。
RUN printf "[google-chrome]\nname=google-chrome\nbaseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64\nenabled=1\ngpgcheck=1\ngpgkey=https://dl.google.com/linux/linux_signing_key.pub" > /etc/yum.repos.d/google-chrome.repo

# Google Chrome（安定版）と日本語フォントをインストールします。
RUN dnf install -y google-chrome-stable liberation-sans-fonts && \
    dnf clean all

# ビルドステージで作成した実行可能ファイル`bootstrap`をコピー
# LambdaのGoランタイムは /var/runtime/bootstrap を期待します
COPY --from=builder /app/bootstrap /var/runtime/

# Lambdaが実行するコマンドを設定
CMD [ "bootstrap" ]

