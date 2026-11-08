# 1080p video cut of scripts/demo-rename.tape: same session, same theme, but
# rendered onto a 1920x1080 canvas as MP4 instead of a GIF. Every geometry
# setting is roughly the 1.4x scale of the GIF tape, with a wider margin so the
# background reads around the window. The grid lands near 100 cols, wide enough
# that the tool lines stop wrapping.
#   VHS_WINDOW_BAR_COLOR="#22222a" vhs scripts/demo-rename-1080p.tape
#
# vhs renders silent. To lay the music over it (normalize to -14 LUFS, trim to
# the video, fade both ends) and land the shareable copy in demo-runs/ (the
# soundtrack is not tracked; recover it with
# `git show 59f49ff:assets/home-resonance.mp3 > demo-runs/home-resonance.mp3`):
#   ffmpeg -i demo-runs/copperhead-rename-1080p.mp4 -i demo-runs/home-resonance.mp3 \
#     -filter_complex "[1:a]atrim=0:25.64,asetpts=N/SR/TB,\
# loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.4,\
# afade=t=out:st=24.54:d=1.1[a]" \
#     -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -ar 44100 -shortest \
#     -movflags +faststart demo-runs/copperhead-1080p.mp4

Output demo-runs/copperhead-rename-1080p.mp4

Set Shell bash
# Default vhs theme with a darker gray background.
Set Theme { "background": "#0f0f11", "foreground": "#dddddd", "cursor": "#dddddd", "cursorAccent": "#0f0f11", "black": "#282a2e", "brightBlack": "#4d4d4d", "red": "#D74E6F", "brightRed": "#FE5F86", "green": "#31BB71", "brightGreen": "#00D787", "yellow": "#D3E561", "brightYellow": "#EBFF71", "blue": "#8056FF", "brightBlue": "#9B79FF", "magenta": "#ED61D7", "brightMagenta": "#FF7AEA", "cyan": "#04D7D7", "brightCyan": "#00FEFE", "white": "#bfbfbf", "brightWhite": "#e6e6e6" }
Set FontSize 28
Set Width 1920
Set Height 1080
# 1080p frames are expensive to capture: at the 50fps default the recorder
# falls behind and the finished video plays ~1.7x fast. 20fps it can hold.
Set Framerate 20
Set Padding 22
Set Margin 88
Set MarginFill "demo-runs/martin-martz-qqyUN78RmgI-unsplash.jpg"
Set BorderRadius 14
Set WindowBar Colorful
Set WindowBarSize 56
Set TypingSpeed 60ms

# Launch the demo off-screen so the video opens on the settled banner.
Hide
Type "npm run demo:ui"
Enter
Sleep 3s
Show

Sleep 1.5s

# The canned agent run: four sections, ~17s of pinned-row animation.
Type "rename net KEY_DAH to KEY_DASH"
Sleep 600ms
Enter
Sleep 20s

# Hold on the finished run before the video ends.
Sleep 2s
