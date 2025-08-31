# 最終版 Dockerfile
# AWS CodeBuild上で実行する最終コマンド:
# docker buildx build --platform linux/amd64 -t YOUR_AWS_ACCOUNT_ID.dkr.ecr.ap-northeast-1.amazonaws.com/booth-freee-automator:v15.0-final --push .

# ステージ1: ビルダー
# Goのビルド環境として、Lambdaのベースイメージと同じOS (AL2023) を使用します。
FROM public.ecr.aws/lambda/provided:al2023 as builder

# GoとGitをインストールします。
RUN dnf install -y golang git

# アプリケーションのソースコードをコピーします。
WORKDIR /app
COPY main.go .

# Goモジュールを初期化し、依存関係をダウンロードします。
RUN go mod init main && \
    go get github.com/chromedp/chromedp && \
    go get github.com/aws/aws-lambda-go/lambda

# Lambdaで実行可能な形式にGoプログラムをビルドします。
RUN go build -o bootstrap main.go

# ステージ2: 最終的な実行イメージ
FROM public.ecr.aws/lambda/provided:al2023

# ★★★ 最終修正 ★★★
# Chromeが必要とする全ての依存ライブラリを明示的にインストールします。
# これにより、Lambdaの最小環境で発生する「沈黙のクラッシュ」を防ぎます。
RUN dnf install -y \
    alsa-lib \
    atk \
    at-spi2-atk \
    cairo \
    cups-libs \
    gtk3 \
    libX11 \
    libXcomposite \
    libXdamage \
    libXext \
    libXfixes \
    libXi \
    libXrandr \
    libXtst \
    nss \
    pango \
    liberation-sans-fonts && \
    # Googleの公式リポジトリ設定を書き込みます。
    printf "[google-chrome]\nname=google-chrome\nbaseurl=https://dl.google.com/linux/chrome/rpm/stable/x86_64\nenabled=1\ngpgcheck=1\ngpgkey=https://dl.google.com/linux/linux_signing_key.pub" > /etc/yum.repos.d/google-chrome.repo && \
    # 依存関係が揃った状態で、Google Chrome 本体をインストールします。
    dnf install -y google-chrome-stable && \
    # キャッシュをクリーンアップしてイメージサイズを削減します。
    dnf clean all

# ビルドステージで作成したGoの実行可能ファイルをコピーします。
COPY --from=builder /app/bootstrap /var/runtime/

# Lambdaが実行するコマンドを指定します。
CMD [ "/var/runtime/bootstrap" ]

