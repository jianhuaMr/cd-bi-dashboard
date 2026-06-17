param(
  [string]$ProjectName = "cdbrown01",
  [string]$Branch = "main",
  [string]$Token = $env:CLOUDFLARE_API_TOKEN
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root "dist-cloudflare-pages"

if (!(Test-Path (Join-Path $dist "index.html"))) {
  throw "Build folder not found: $dist"
}

if (!$Token) {
  throw "Missing Cloudflare API token. Set CLOUDFLARE_API_TOKEN or pass -Token."
}

$env:CLOUDFLARE_API_TOKEN = $Token
npx wrangler pages deploy $dist --project-name $ProjectName --branch $Branch --commit-dirty=true
