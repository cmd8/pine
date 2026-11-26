# The Pine app for Homebrew, from this repository as a tap, until homebrew/cask takes it under the
# same name: then this folder goes and tap_migrations.json sends installs there. The version stays
# where it is between releases on purpose: the app updates itself (auto_updates), so a new install
# starts at this version and moves to the latest at once, and no release has to commit here.
cask "pmndre-pine" do
  arch arm: "arm64", intel: "x64"

  version "0.62.0"
  sha256 arm:   "f3e9611b5abc2cd31f4dac74d9c03e18f3fcd5bbdafdcec818fdeef9263482bc",
         intel: "5324ed8a0603f57651c88a9b16083f0c649eb35648ff76b266adf257b9f2c69c"

  url "https://github.com/pmndre/pine/releases/download/v#{version}/Pine-#{version}-#{arch}.dmg"
  name "Pine"
  desc "Event-driven multi-agent daemon and its desktop app"
  homepage "https://github.com/pmndre/pine"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :ventura

  app "Pine.app"

  zap trash: [
    "~/Library/Application Support/Pine",
    "~/Library/Caches/dev.pine.desktop",
    "~/Library/Caches/dev.pine.desktop.ShipIt",
    "~/Library/HTTPStorages/dev.pine.desktop",
    "~/Library/Preferences/dev.pine.desktop.plist",
    "~/Library/Saved Application State/dev.pine.desktop.savedState",
  ]
end
