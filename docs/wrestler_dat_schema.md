# EWR 4.2 wrestler.dat schema (locked)

## Record layout
- Record size: 307 bytes
- Record marker: 0x34 (ASCII '4') at offset +0
- Worker ID: uint16 little-endian at offset +1

## Names
- Full Name: ASCII, fixed length (your locked length), at offset +?
- Short Name: ASCII, fixed length (your locked length), at offset +?

## Core fields (raw)
- Gender: offset +? (raw values: 0 = Female, 65535 = Male)
- Birth Month: offset +? (0 = Unknown, 1..12 = Jan..Dec)
- Age: offset +?
- Weight: offset +? (72 = Heavyweight, 76 = Lightweight)
- Nationality: offset +? (0 Other, 1 American, 2 Australian, 3 British, 4 Canadian, 5 European, 6 Japanese, 7 Mexican)
- Speaks: offset +? (0 = No, 65535 = Yes)
- Wage (thousands): offset +? (uint16 LE)

## Skills (0-100)
- Brawling: offset +?
- Speed: offset +?
- Technical: offset +?
- Stiffness: offset +?
- Selling: offset +?
- Overness: offset +?
- Charisma: offset +?
- Attitude: offset +?
- Behaviour: offset +?

## Finishers
Primary Finisher Name:
- Offset +?
- ASCII length 25

Primary Finisher Type flags (raw):
- Flag A offset +?
- Flag B offset +?
- Flag C offset +?
- Flag D offset +?

Secondary Finisher Name:
- Offset +?
- ASCII length 25

Secondary Finisher Type flags (raw):
- Flag A offset +?
- Flag B offset +?
- Flag C offset +?

## Checkbox flags (raw 0/65535)
List each:
- Diva: offset +?
- Trainer: offset +?
- Superstar Look: offset +?
- Menacing: offset +?
- Fonz Factor: offset +?
- Announcer: offset +?
- Booker: offset +?
- High Spots: offset +?
- Shooting Ability: offset +?
