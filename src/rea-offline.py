"""Run the installed REA CLI with its online routes disabled.

This guard is for the reviewed REA Python implementation, not an operating
system sandbox for arbitrary executables. FFmpeg and ffprobe only receive local
source paths from the engine. Download helpers and Python sockets fail closed.
"""
import socket
import sys


def offline(*_args, **_kwargs):
    raise OSError("Video engine reference analysis runs offline; downloads and network access are disabled")


socket.socket.connect = offline
socket.socket.connect_ex = offline
socket.create_connection = offline

import rea_video.util

rea_video.util.fetch = offline
if sys.argv[1:] == ["--engine-check-ocr"]:
    from rea_video.overlay import get_ocr
    sys.exit(0 if get_ocr() is not None else 2)
from rea_video.cli import main

sys.exit(main())
