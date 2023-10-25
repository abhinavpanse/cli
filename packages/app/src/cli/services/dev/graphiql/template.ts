import {platformAndArch} from '@shopify/cli-kit/node/os'

const controlKey = platformAndArch().platform === 'darwin' ? 'MAC_COMMAND_KEY' : 'Ctrl'

const graphiqlIntroMessage = `
# Welcome to the Shopify GraphiQL Explorer! If you've used GraphiQL before,
# you can go ahead and jump to the next tab.
#
# GraphiQL is an in-browser tool for writing, validating, and
# testing GraphQL queries.
#
# Type queries into this side of the screen, and you will see intelligent
# typeaheads aware of the current GraphQL type schema and live syntax and
# validation errors highlighted within the text.
#
# GraphQL queries typically start with a "{" character. Lines that start
# with a # are ignored.
#
# Keyboard shortcuts:
#
#   Prettify query:  Shift-${controlKey}-P (or press the prettify button)
#
#  Merge fragments:  Shift-${controlKey}-M (or press the merge button)
#
#        Run Query:  ${controlKey}-Enter (or press the play button)
#
#    Auto Complete:  ${controlKey}-Space (or just start typing)
#
`

export const defaultQuery = `query shopInfo {
  shop {
    name
    url
    myshopifyDomain
    plan {
      displayName
      partnerDevelopment
      shopifyPlus
    }
  }
}
`.replace(/\n/g, '\\n')

export const template = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <title>GraphiQL</title>
    <style>
      body {
        height: 100%;
        margin: 0;
        width: 100%;
        overflow: hidden;
      }
      .top-bar {
        padding: 0 4px;
        border-bottom: 1px solid #d6d6d6;
        font-family: Inter, sans-serif;
        font-size: 0.85em;
        color: #666;
      }
      .top-bar a {
        text-decoration: none;
      }
      #top-error-bar {
        display: none;
        background-color: #ff0000;
        color: #ffffff;
      }
      .top-bar p {
        margin: 0;
      }
      .top-bar .container {
        margin: 0;
        display: flex;
        flex-direction: row;
        align-content: start;
        align-items: stretch;
      }
      .top-bar .container:not(.bounded) {
        width: 100%;
      }
      .top-bar .container.bounded {
        max-width: 1200px;
        flex-wrap: wrap;
      }
      .top-bar .box {
        text-align: left;
        align-self: center;
        padding: 16px;
      }
      .top-bar .box.align-right {
        text-align: right;
        flex-grow: 1;
      }
      #graphiql {
        height: 100vh;
        display: flex;
        flex-direction: column;
      }
      #graphiql-explorer {
        flex-grow: 1;
        overflow: auto;
      }
      .box {
        border-right: 1px solid var(--border-border-subdued, #EBEBEB);
      }
      .status-container {

      }
      .status-pill {
        padding: 2px 6px 2px 2px;
        border-radius: 8px;
      }
      .status-pill.connected {
        background: rgba(0, 0, 0, 0.03);
      }
      #version-select {
        border-radius: 0.5rem;
        border: 0.66px solid var(--input-subdued-border, #B5B5B5);
        background: var(--input-surface, #FDFDFD);
        padding: 0.5rem 0.75rem 0.5rem 0.5rem;
      }
      .link-pill::before {
        content: '🔗';
        margin-right: 0.5rem;
      }
      .link-pill {
        border-radius: 8px;
        background: var(--global-azure-04, #E0F0FF);
        padding: 0.25rem 0.5rem 0.25rem 0.25rem;
        margin-left: 0.5rem;
      }
      .link-pill a {
        color: var(--global-azure-10, #006AFF);
      }
    </style>
    <script
      src="https://unpkg.com/react@17/umd/react.development.js"
      integrity="sha512-Vf2xGDzpqUOEIKO+X2rgTLWPY+65++WPwCHkX2nFMu9IcstumPsf/uKKRd5prX3wOu8Q0GBylRpsDB26R6ExOg=="
      crossorigin="anonymous"
    ></script>
    <script
      src="https://unpkg.com/react-dom@17/umd/react-dom.development.js"
      integrity="sha512-Wr9OKCTtq1anK0hq5bY3X/AvDI5EflDSAh0mE9gma+4hl+kXdTJPKZ3TwLMBcrgUeoY0s3dq9JjhCQc7vddtFg=="
      crossorigin="anonymous"
    ></script>
    <link rel="stylesheet" href="https://unpkg.com/graphiql/graphiql.min.css" />
  </head>
  <body>
    <div id="graphiql">
      <div id="top-error-bar" class="top-bar">
        <div class="box">⚠️ The server has been stopped. Restart <code>dev</code> and launch the GraphiQL Explorer from the terminal again.</div>
      </div>
      <div class="top-bar">
        <div class="container">
          <div class="container bounded">
            <div class="box status-container">
              Status: <span class="status-pill connected" id="status">🟢 Running</span>
            </div>
            <div class="box">
              API version:
              <select id="version-select">
                {% for version in versions %}
                  <option value="{{ version }}" {% if version == apiVersion %}selected{% endif %}>{{ version }}</option>
                {% endfor %}
              </select>
            </div>
            <div class="box">
              Store: <span class="link-pill"><a href="https://{{ storeFqdn }}/admin" target="_blank">{{ storeFqdn }}</a></span>
            </div>
            <div class="box">
              App: <span class="link-pill"><a href="{{ appUrl }}" target="_blank">{{ appName }}</a></span>
            </div>
          </div>
          <div class="box align-right">
            GraphiQL runs on the same access scopes you’ve defined in the toml file for your app.
          </div>
        </div>
      </div>
      <div id="graphiql-explorer">Loading...</div>
    </div>
    <script
      src="https://unpkg.com/graphiql@3.0.4/graphiql.min.js"
      type="application/javascript"
    ></script>
    <script>
      const macCommandKey = String.fromCodePoint(8984)
      const renderGraphiQL = function(apiVersion) {
        ReactDOM.render(
          React.createElement(GraphiQL, {
            fetcher: GraphiQL.createFetcher({
              url: '{{url}}/graphiql/graphql.json?api_version=' + apiVersion,
            }),
            defaultEditorToolsVisibility: true,
            defaultTabs: [
              {query: "${graphiqlIntroMessage
                .replace(/"/g, '\\"')
                .replace(/\n/g, '\\n')}".replace(/MAC_COMMAND_KEY/g, macCommandKey)},
              {%for query in defaultQueries%}
                {query: "{%if query.preface %}{{query.preface}}\\n{% endif %}{{query.query}}", variables: "{{query.variables}}"},
              {%endfor%}
            ],
          }),
          document.getElementById('graphiql-explorer'),
        )
      }
      renderGraphiQL('{{apiVersion}}')

      // Update the version when the select changes
      document.getElementById('version-select').addEventListener('change', function(event) {
        renderGraphiQL(event.target.value)
      })

      // Warn when the server has been stopped
      const pingInterval = setInterval(function() {
        const topErrorBar = document.querySelector('#graphiql #top-error-bar')
        const statusDiv = document.querySelector('#graphiql #status')
        const displayErrorServerStopped = function() {
          topErrorBar.style.display = 'block'
          statusDiv.innerHTML = '❌ Disconnected'
        }
        const displayErrorServerStoppedTimeout = setTimeout(displayErrorServerStopped, 3000)
        fetch('{{url}}/graphiql/ping')
          .then(function(response) {
            if (response.status === 200) {
              clearTimeout(displayErrorServerStoppedTimeout)
              topErrorBar.style.display = 'none'
              statusDiv.innerHTML = '🟢 Running'
            } else {
              displayErrorServerStopped()
            }
          })
      }, 2000)
    </script>
  </body>
</html>
`
