/**
 * Node floor check. `node:sqlite` is the persistence layer and it only exists without a flag
 * from 22.13 onward, so an older runtime dies deep inside a stack trace that names an internal
 * module instead of the actual problem. Imported first wherever the database is opened.
 */
const [major, minor] = process.versions.node.split(".").map((n) => Number.parseInt(n, 10));

if (major < 22 || (major === 22 && minor < 13)) {
  throw new Error(
    `SocialDeck needs Node 22.13 or newer (found ${process.versions.node}).\n` +
      "The built-in node:sqlite module does not exist in this runtime.\n" +
      "Upgrade with one of:\n" +
      "  nvm install 22 && nvm use 22\n" +
      "  apt-get install -y nodejs   (from NodeSource, not the distro package)\n" +
      "  curl -fsSL https://fnm.vercel.app/install | bash && fnm use 22\n" +
      "Several Linux distributions and Termux still ship Node 20 or older by default.",
  );
}
