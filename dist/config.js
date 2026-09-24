// Public site settings, read by both the page and the server.
// ticker: the coin's ticker without "$" (e.g. 'PAID'). Posts must mention $TICKER or the coin address.
// Until it is set, new submissions are refused.
// coinAddress: the coin's contract address. Populates the CA line and Buy dialog.
export const config = Object.freeze({ ticker: 'GETPAID', coinAddress: '', buyUrl: '' });
