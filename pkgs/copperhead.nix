{
  lib,
  buildNpmPackage,
  git,
  kicad,
  makeWrapper,
  nodejs_22,
  openspec,
  stdenv,
}:

let
  runtimePackages = [ git openspec ] ++ lib.optionals stdenv.hostPlatform.isLinux [ kicad ];
in
buildNpmPackage {
  pname = "copperhead";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../LICENSE
      ../NOTICE
      ../README.md
      ../examples
      ../package-lock.json
      ../package.json
      ../src
      ../tsconfig.json
    ];
  };

  nodejs = nodejs_22;
  npmDepsHash = "sha256-t0hEH/fVsbJFnOLl+LpTdbKqs+j/utyce9t3Ktx4vJU=";

  nativeBuildInputs = [ makeWrapper ];

  postInstall = ''
    cp -r examples $out/lib/node_modules/copperhead/
  '';

  postFixup = ''
    wrapProgram $out/bin/copperhead \
      --prefix PATH : ${lib.makeBinPath runtimePackages}
  '';

  meta = {
    description = "AI agent that designs, documents, and validates KiCad projects";
    homepage = "https://copperhead.sh";
    license = lib.licenses.asl20;
    mainProgram = "copperhead";
  };
}
