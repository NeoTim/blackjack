Blackjack
=========
This blackjack calculator and game runs with modern web technology.  It is
still in alpha, not intended for use right now.

The computational part is an [asm.js module][module] for near-native
performance.  For more information on asm.js, please visit [its official
website][asmjs].

Calculator
----------
The expectancy and strategy calculator is in [the project homepage][index].  It
generates results based on Hi-Lo card counting and variation of rules of the
game.

Game
----
The game is an [SVG application][game] driven by JavaScript.  SVG instead of
canvas is chosen because

* It can stand alone, easier to be embedded
* Reuse of existing vectorized playing cards
* Separation of presentation and content.

[asmjs]:  http://asmjs.org/
[module]: blackjack.js
[index]:  index.html
[game]:   game.svg
