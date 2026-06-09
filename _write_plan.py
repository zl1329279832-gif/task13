import os

plan_path = r"C:/Users/13292/.claude/plans/zesty-yawning-toucan-agent-af086f1cb4695f795.md"
bt = chr(96)  # backtick
bt3 = bt * 3

content = []

def section(title):
    content.append("")
    content.append(title)
    content.append("")

def para(text):
    content.append(text)
    content.append("")

def codeblock(lang, code):
    content.append(bt3 + lang)
    content.append(code)
    content.append(bt3)
    content.append("")
