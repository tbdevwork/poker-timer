#!/usr/bin/env python3
"""Builds the single-file index.html from src/template.html + src/style.css + src/app.js.
Edit the files in src/, then run:  python3 build.py"""
import os
d = os.path.dirname(os.path.abspath(__file__))
rd = lambda p: open(os.path.join(d, p), encoding='utf-8').read()
html = rd('src/template.html').replace('/*CSS*/', rd('src/style.css').strip()).replace('/*JS*/', rd('src/app.js').strip())
open(os.path.join(d, 'index.html'), 'w', encoding='utf-8').write(html)
print('built index.html', len(html), 'bytes')
