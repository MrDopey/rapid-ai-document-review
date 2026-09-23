FROM node:26.1.0-trixie

ARG USER_ID=1001
ARG GROUP_ID=1001
ARG USERNAME=lovely

RUN $(groupadd -g $GROUP_ID $USERNAME || true) && \
    useradd -m -s /bin/bash -u $USER_ID -g $GROUP_ID $USERNAME

# Install basic development tools
RUN apt update && apt install -y less man-db sudo

# Ensure default `node` user has access to `sudo`
RUN echo $USERNAME ALL=\(root\) NOPASSWD:ALL > /etc/sudoers.d/$USERNAME \
    && chmod 0440 /etc/sudoers.d/$USERNAME

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Github cli https://github.com/cli/cli/blob/trunk/docs/install_linux.md#debian
RUN (type -p wget >/dev/null || (apt update && apt install wget -y)) \
	&& mkdir -p -m 755 /etc/apt/keyrings \
	&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& cat $out | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& mkdir -p -m 755 /etc/apt/sources.list.d \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
	&& apt update \
	&& apt install gh -y

RUN apt-get update && apt-get install -y \
	fd-find \
	jq \
	ripgrep

RUN npm install --global openwiki@1.5.2

USER $USERNAME

# claude + uv + pi
RUN curl -fsSL https://claude.ai/install.sh | bash \
	&& curl -LsSf https://astral.sh/uv/install.sh | sh \
	&& curl -fsSL https://pi.dev/install.sh | sh

RUN npx playwright install chromium
