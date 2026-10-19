class Unreadable(Exception):
    """The file is encrypted, damaged or not something the extractor reads: the worker fails the version at once."""


class TooLarge(Exception):
    """The file holds more text than the deployment allows."""
