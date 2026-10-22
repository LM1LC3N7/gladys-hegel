# Third-party notices

This integration ports to JavaScript the logic of the following project: the
Hegel IP control protocol (`-<letter>.<value>` lines ended by a carriage
return, `?` to read a value, answers and pushed changes of the same form, TCP
port 50001), the command letters and values (`-p` power 0/1, `-v` volume
0..100, `-m` mute 0/1, `-i` input number), the reading of the answers, and the
routing of each answer to the one command in flight, any other line being a
pushed change (`src/hegel/`). Nothing of it is installed at runtime; its notice
is reproduced below.

## hegel-ip-client 0.1.4

<https://github.com/boazca/hegel-ip-client> (the library behind the Home
Assistant Hegel integration), version 0.1.4 of 2025-12-27

```
MIT License

Copyright (c) 2024

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The license file of the project names no copyright holder (only the year);
it is reproduced as published.

## LM1LC3N7/gladys-nad

The structure of the app, the persistent link (one exchange at a time,
deadlines, spaced reconnection, poll), the command queue and budget, the
volume cap on unmute and power on, the `/data` store and the handler wiring
follow this integration of the same author, under the Apache License 2.0 of
this repository.
