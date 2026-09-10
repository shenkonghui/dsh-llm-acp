.PHONY: test-acp

# End-to-end ACP server test: handshake → models → probe prompt.
# Usage: make test-acp cmd="devin acp"
test-acp:
	node scripts/test-acp.mjs --cmd "$(cmd)"
