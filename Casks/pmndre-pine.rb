# The Pine app for Homebrew, from this repository as a tap, until homebrew/cask takes it under the
# same name: then this folder goes and tap_migrations.json sends installs there. The version stays
# where it is between releases on purpose: the app updates itself (auto_updates), so a new install
# starts at this version and moves to the latest at once, and no release has to commit here.
cask "pmndre-pine" do
  arch arm: "arm64", intel: "x64"

  version "0.62.0"
  sha256 arm:   "492ea9aa0294a6edfffeba10267b27f9355fea5b3a3f67ed21b652d07fd6151a",
         intel: "0ef5446a0bb33238743fc4191bd11b299f68dae7cd7d5eea56c5b28cb7062e41"

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
