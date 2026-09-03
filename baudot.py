"""
Baudot (ITA2) 5-bit code tables.
Letters shift only, for simplicity — covers A-Z, space, and a CR/LF/figures
shift if needed. For "HELLO WORLD" we only need letters + space.
"""

# ITA2 Letters shift table: code (0-31) -> character
ITA2_LETTERS = {
    0b00000: '\x00',  # NULL / blank
    0b00011: 'A',
    0b11001: 'B',
    0b01110: 'C',
    0b01001: 'D',
    0b00001: 'E',
    0b01101: 'F',
    0b11010: 'G',
    0b10100: 'H',
    0b00110: 'I',
    0b01011: 'J',
    0b01111: 'K',
    0b10010: 'L',
    0b11100: 'M',
    0b01100: 'N',
    0b11000: 'O',
    0b10110: 'P',
    0b10111: 'Q',
    0b01010: 'R',
    0b00101: 'S',
    0b10000: 'T',
    0b00111: 'U',
    0b11110: 'V',
    0b10011: 'W',
    0b11101: 'X',
    0b10101: 'Y',
    0b10001: 'Z',
    0b00100: ' ',   # SPACE
    0b01000: '\n',  # LINE FEED
    0b00010: '\r',  # CARRIAGE RETURN
    0b11111: '^',   # FIGS shift (unused here, placeholder symbol)
    0b11011: '_',   # LTRS shift (unused here, placeholder symbol)
}

# Reverse map: character -> 5-bit code
CHAR_TO_CODE = {v: k for k, v in ITA2_LETTERS.items()}


def text_to_symbols(text):
    """
    Convert text (letters, spaces, CR/LF only) to a list of 5-bit symbol
    values (0-31), uppercased. Unsupported characters raise an error so you
    know immediately rather than silently mangling data.
    """
    text = text.upper()
    symbols = []
    for ch in text:
        if ch not in CHAR_TO_CODE:
            raise ValueError(
                f"Character {ch!r} not supported in this Baudot letters-only "
                f"subset. Supported: A-Z, space, CR, LF."
            )
        symbols.append(CHAR_TO_CODE[ch])
    return symbols


def symbols_to_text(symbols):
    """Convert a list of 5-bit symbol values (0-31) back to text."""
    chars = []
    for s in symbols:
        chars.append(ITA2_LETTERS.get(s, '?'))  # '?' marks an undecodable symbol
    return ''.join(chars)


if __name__ == "__main__":
    msg = "HELLO WORLD"
    syms = text_to_symbols(msg)
    print(f"'{msg}' -> {len(syms)} symbols x 5 bits = {len(syms)*5} bits")
    print("Symbols:", syms)
    print("Round-trip:", symbols_to_text(syms))
