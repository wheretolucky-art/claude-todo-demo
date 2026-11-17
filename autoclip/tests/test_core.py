import json
import random

from autoclip.captions import Word, chunk, write_ass
from autoclip.chat import channel_from_url, load_chat_log, parse_privmsg
from autoclip.spikes import ChatBuckets, DetectorSettings, SpikeDetector, merge_windows


def feed(scores, **kw):
    det = SpikeDetector(DetectorSettings(**kw), "chat")
    return [s for i, sc in enumerate(scores) if (s := det.add(i * 10.0, sc))]


def test_quiet_noisy_chat_has_no_spikes():
    rng = random.Random(1)
    assert feed([rng.randint(8, 14) for _ in range(200)]) == []


def test_burst_is_found_once():
    scores = [10] * 30 + [45, 50] + [10] * 30
    spikes = feed(scores)
    assert [s.start for s in spikes] == [300.0]
    assert spikes[0].ratio > 3


def test_two_moments_after_cooldown():
    scores = [10] * 30 + [50] + [10] * 10 + [55] + [10] * 10
    assert [s.start for s in feed(scores)] == [300.0, 410.0]


def test_dead_chat_needs_min_score():
    assert feed([0] * 20 + [5] + [0] * 5) == []
    assert len(feed([0] * 20 + [12] + [0] * 5)) == 1


def test_chat_buckets_close_empty_buckets():
    b = ChatBuckets(10)
    assert b.add(1, "hi") == []
    b.add(2, "KEKW KEKW")
    closed = b.advance(35)
    assert [c[0] for c in closed] == [0, 10, 20]
    assert closed[0][1] == 2 + 0.5 * 2 and closed[1][1] == 0


def test_merge_windows():
    assert merge_windows([(50, 80), (0, 30), (25, 40)]) == [(0, 40), (50, 80)]


def test_parse_privmsg():
    line = ":some_user!some_user@some_user.tmi.twitch.tv PRIVMSG #chan :LETS GOOO : yes"
    assert parse_privmsg(line) == ("some_user", "LETS GOOO : yes")
    assert parse_privmsg(":tmi.twitch.tv 001 justinfan1 :Welcome") is None


def test_channel_from_url():
    assert channel_from_url("https://www.twitch.tv/SomeOne?ref=x") == "someone"
    assert channel_from_url("someone") == "someone"


def test_chat_log_formats(tmp_path):
    p = tmp_path / "a.txt"
    p.write_text("0:01:05 hello\n12.5\tKEKW\n")
    assert load_chat_log(p) == [(12.5, "KEKW"), (65.0, "hello")]

    p = tmp_path / "b.jsonl"
    p.write_text('{"t": 1000.0, "text": "a"}\n{"t": 1012.0, "text": "b"}\n')
    assert load_chat_log(p) == [(0.0, "a"), (12.0, "b")]

    p = tmp_path / "c.json"
    p.write_text(json.dumps({"comments": [{"content_offset_seconds": 3, "message": {"body": "W"}}]}))
    assert load_chat_log(p) == [(3.0, "W")]


def test_captions_chunk_and_ass(tmp_path):
    words = [Word(0, .3, "no"), Word(.3, .6, "way"), Word(.6, .9, "bro."),
             Word(.9, 1.2, "what"), Word(3.0, 3.3, "happened")]
    assert [[w.text for w in g] for g in chunk(words)] == [["no", "way", "bro."], ["what"], ["happened"]]
    out = write_ass(words, tmp_path / "c.ass", y=1450)
    text = out.read_text()
    assert text.count("Dialogue:") == 5
    assert "\\pos(540,1450)" in text and "NO WAY BRO." in text.replace("{\\r}", "").replace(
        "{\\c&H0000E5FF&\\fscx112\\fscy112}", "")
