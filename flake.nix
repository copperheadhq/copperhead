{
  description = "Copperhead, an AI agent for KiCad projects";

  inputs = {
    nixpkgs.url = "https://github.com/NixOS/nixpkgs/archive/dc5d91f840324650bac8c379428c7037a416959a.tar.gz";
    flake-utils.url = "github:numtide/flake-utils/11707dc2f618dd54ca8739b309ec4fc024de578b";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ self.overlays.default ];
        };
      in {
        packages = {
          inherit (pkgs) copperhead;
          default = pkgs.copperhead;
        };

        checks.default = pkgs.copperhead;

        devShells.default = pkgs.mkShell {
          inputsFrom = [ pkgs.copperhead ];
          packages = [
            pkgs.git
            pkgs.nodejs_22
            pkgs.openspec
          ] ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.kicad ];
        };
      }) // {
        overlays.default = final: prev: {
          copperhead = final.callPackage ./pkgs/copperhead.nix { };
        };
      };
}
