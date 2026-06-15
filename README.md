# mcp-client

MCP client plugin — connects to MCP servers and registers tools as native CLI commands

[![Version](https://img.shields.io/npm/v/@hesed/mcp-client.svg)](https://npmjs.org/package/@hesed/mcp-client)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/hesedcasa/@hesed/mcp-client/blob/main/LICENSE)
[![Downloads/week](https://img.shields.io/npm/dw/@hesed/mcp-client.svg)](https://npmjs.org/package/@hesed/mcp-client)

<!-- toc -->
* [mcp-client](#mcp-client)
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->

# Usage

<!-- usage -->
```sh-session
$ npm install -g @hesed/mcp-client
$ mcp-client COMMAND
running command...
$ mcp-client (--version)
@hesed/mcp-client/0.2.0 linux-x64 node-v22.22.3
$ mcp-client --help [COMMAND]
USAGE
  $ mcp-client COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`mcp-client mcp client add NAME`](#mcp-client-mcp-client-add-name)
* [`mcp-client mcp client auth NAME`](#mcp-client-mcp-client-auth-name)
* [`mcp-client mcp client list`](#mcp-client-mcp-client-list)
* [`mcp-client mcp client refresh [NAME]`](#mcp-client-mcp-client-refresh-name)
* [`mcp-client mcp client remove NAME`](#mcp-client-mcp-client-remove-name)

## `mcp-client mcp client add NAME`

Add an MCP server and register its tools as native CLI commands

```
USAGE
  $ mcp-client mcp client add NAME [--args <value>...] [-c <value>] [--env <value>...] [--header <value>...] [-u
    <value>]

ARGUMENTS
  NAME  Name for the MCP server

FLAGS
  -c, --command=<value>    Command to run the MCP server (stdio transport)
  -u, --url=<value>        URL of the MCP server (http transport)
      --args=<value>...    Argument to pass to the server command (repeatable)
      --env=<value>...     Environment variable for the server process as KEY=VALUE (repeatable)
      --header=<value>...  HTTP header for the MCP server as Key=Value (repeatable)

DESCRIPTION
  Add an MCP server and register its tools as native CLI commands

EXAMPLES
  $ mcp-client mcp client add github --command npx --args @modelcontextprotocol/server-github

  $ mcp-client mcp client add myserver --command ./bin/server.js --args start --env API_KEY=abc123

  $ mcp-client mcp client add remote --url http://localhost:3000/mcp

  $ mcp-client mcp client add remote --url https://api.example.com/mcp --header Authorization="Bearer token"
```

_See code: [src/commands/mcp/client/add.ts](https://github.com/hesedcasa/mcp-client/blob/v0.2.0/src/commands/mcp/client/add.ts)_

## `mcp-client mcp client auth NAME`

Re-authenticate an HTTP MCP server via OAuth browser flow

```
USAGE
  $ mcp-client mcp client auth NAME

ARGUMENTS
  NAME  Name of the MCP server to re-authenticate

DESCRIPTION
  Re-authenticate an HTTP MCP server via OAuth browser flow

EXAMPLES
  $ mcp-client mcp client auth browserstack-remote
```

_See code: [src/commands/mcp/client/auth.ts](https://github.com/hesedcasa/mcp-client/blob/v0.2.0/src/commands/mcp/client/auth.ts)_

## `mcp-client mcp client list`

List configured MCP servers and their cached tools

```
USAGE
  $ mcp-client mcp client list [-t]

FLAGS
  -t, --tools  Show individual tools for each server

DESCRIPTION
  List configured MCP servers and their cached tools

EXAMPLES
  $ mcp-client mcp client list

  $ mcp-client mcp client list --tools
```

_See code: [src/commands/mcp/client/list.ts](https://github.com/hesedcasa/mcp-client/blob/v0.2.0/src/commands/mcp/client/list.ts)_

## `mcp-client mcp client refresh [NAME]`

Refresh the cached tool list for one or all MCP servers

```
USAGE
  $ mcp-client mcp client refresh [NAME]

ARGUMENTS
  [NAME]  Name of the MCP server to refresh (refreshes all if omitted)

DESCRIPTION
  Refresh the cached tool list for one or all MCP servers

EXAMPLES
  $ mcp-client mcp client refresh

  $ mcp-client mcp client refresh github
```

_See code: [src/commands/mcp/client/refresh.ts](https://github.com/hesedcasa/mcp-client/blob/v0.2.0/src/commands/mcp/client/refresh.ts)_

## `mcp-client mcp client remove NAME`

Remove a configured MCP server and its cached tools

```
USAGE
  $ mcp-client mcp client remove NAME

ARGUMENTS
  NAME  Name of the MCP server to remove

DESCRIPTION
  Remove a configured MCP server and its cached tools

EXAMPLES
  $ mcp-client mcp client remove github
```

_See code: [src/commands/mcp/client/remove.ts](https://github.com/hesedcasa/mcp-client/blob/v0.2.0/src/commands/mcp/client/remove.ts)_
<!-- commandsstop -->
