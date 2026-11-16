// The interviewer's question bank. Kept as plain data in code so the project
// needs no database migration or admin UI; adding a question is one entry.
//
// `hints` are for the interviewer only. The server strips them before a
// question is put into the shared document (see toPublic).

export interface Question {
  id: string;
  title: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  topics: string[];
  statement: string;
  hints: string;
}

export type PublicQuestion = Omit<Question, 'hints'>;

export const toPublic = ({ hints: _hints, ...rest }: Question): PublicQuestion => rest;

export const QUESTIONS: Question[] = [
  {
    id: 'two-sum',
    title: 'Two Sum',
    difficulty: 'Easy',
    topics: ['array', 'hash map'],
    statement: `Given an array of integers nums and an integer target, return the indices of the two numbers that add up to target.

Each input has exactly one solution, and you may not use the same element twice.

Example
  Input:  nums = [2, 7, 11, 15], target = 9
  Output: [0, 1]

Constraints
  2 <= nums.length <= 10^5
  -10^9 <= nums[i], target <= 10^9`,
    hints: `Brute force is O(n^2). Look for the jump to one pass with a hash map (value -> index), O(n) time and O(n) space.
Follow-ups: what if the array is sorted (two pointers, O(1) space)? What if there can be several answers?`,
  },
  {
    id: 'valid-parentheses',
    title: 'Valid Parentheses',
    difficulty: 'Easy',
    topics: ['stack', 'string'],
    statement: `Given a string s containing only the characters ( ) { } [ ], decide whether it is valid.

A string is valid when every opening bracket is closed by the same type of bracket, in the correct order.

Examples
  "()[]{}"  -> true
  "(]"      -> false
  "([)]"    -> false
  "{[]}"    -> true

Constraints
  1 <= s.length <= 10^4`,
    hints: `Stack of opening brackets; on a closing bracket the top must match. Check the empty-stack case and that the stack is empty at the end.
Follow-up: only one bracket type -> a counter is enough. Why does a counter fail with several types?`,
  },
  {
    id: 'reverse-linked-list',
    title: 'Reverse a Linked List',
    difficulty: 'Easy',
    topics: ['linked list', 'pointers'],
    statement: `Define a singly linked list node, then write a function that reverses a list and returns the new head.

Example
  Input:  1 -> 2 -> 3 -> 4 -> 5
  Output: 5 -> 4 -> 3 -> 2 -> 1

Write a small test that builds a list, reverses it and prints it.`,
    hints: `Iterative: prev / curr / next pointers, O(n) time, O(1) space. Ask for the recursive version too and its stack depth.
Watch for: losing the rest of the list before saving next, and the empty list.`,
  },
  {
    id: 'longest-substring',
    title: 'Longest Substring Without Repeating Characters',
    difficulty: 'Medium',
    topics: ['sliding window', 'hash map'],
    statement: `Given a string s, return the length of the longest substring that contains no repeated character.

Examples
  "abcabcbb" -> 3   ("abc")
  "bbbbb"    -> 1   ("b")
  "pwwkew"   -> 3   ("wke")

Constraints
  0 <= s.length <= 5 * 10^4`,
    hints: `Sliding window with a map of char -> last index; move the left edge to max(left, last[c] + 1). O(n).
Common bug: moving left backwards when the repeated char is outside the window ("abba").`,
  },
  {
    id: 'merge-intervals',
    title: 'Merge Intervals',
    difficulty: 'Medium',
    topics: ['sorting', 'intervals'],
    statement: `Given a list of intervals [start, end], merge all overlapping intervals and return the result sorted by start.

Example
  Input:  [[1,3], [2,6], [8,10], [15,18]]
  Output: [[1,6], [8,10], [15,18]]

  Input:  [[1,4], [4,5]]
  Output: [[1,5]]

Constraints
  1 <= intervals.length <= 10^4`,
    hints: `Sort by start, then sweep: extend the last merged interval if current.start <= last.end. O(n log n).
Ask: do touching intervals merge ([1,4],[4,5])? Good candidates ask this themselves.`,
  },
  {
    id: 'lru-cache',
    title: 'LRU Cache',
    difficulty: 'Medium',
    topics: ['design', 'hash map', 'linked list'],
    statement: `Design a cache with a fixed capacity that evicts the least recently used key when it is full.

  get(key)        -> the value, or -1 if the key is absent. Counts as a use.
  put(key, value) -> insert or update. Counts as a use. Evict if over capacity.

Both operations must run in O(1) average time.

Example (capacity 2)
  put(1, 1), put(2, 2), get(1) -> 1
  put(3, 3)            evicts key 2
  get(2) -> -1`,
    hints: `Hash map + doubly linked list (map gives the node, list gives the order). Accept OrderedDict / Map insertion order, then ask them to build it by hand.
Listen for: sentinel head/tail nodes, updating an existing key, capacity 1.`,
  },
  {
    id: 'number-of-islands',
    title: 'Number of Islands',
    difficulty: 'Medium',
    topics: ['graph', 'BFS', 'DFS'],
    statement: `Given a grid of '1' (land) and '0' (water), count the islands. An island is land connected horizontally or vertically.

Example
  11000
  11000
  00100
  00011
  Output: 3

Constraints
  1 <= rows, cols <= 300`,
    hints: `Flood fill (DFS/BFS) from every unvisited land cell, O(rows * cols). Recursive DFS can overflow the stack on a 300x300 grid of all land: ask about it.
Follow-up: union-find, or islands arriving as a stream.`,
  },
  {
    id: 'median-two-sorted',
    title: 'Median of Two Sorted Arrays',
    difficulty: 'Hard',
    topics: ['binary search', 'array'],
    statement: `Given two sorted arrays a and b of sizes m and n, return the median of all m + n values.

The target running time is O(log(m + n)).

Examples
  a = [1, 3], b = [2]       -> 2.0
  a = [1, 2], b = [3, 4]    -> 2.5

Constraints
  0 <= m, n <= 1000, m + n >= 1`,
    hints: `Merge is O(m + n) and a fine first answer. The log solution binary-searches a partition of the shorter array so that left halves hold (m + n + 1) / 2 elements and maxLeft <= minRight.
Edge cases: one empty array, partition at an end (use +-infinity).`,
  },
];
