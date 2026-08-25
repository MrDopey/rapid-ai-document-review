
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

export PATH="$HOME/.local/bin:$PATH"

uv tool install specify-cli

specify init --here --integration claude --script sh --non-interactive --force
