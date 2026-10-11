// The one password rule (FEATURE-002). The server (src/validation.js) checks it, and the set and change
// password screens (password-fields.js) show it as a checklist. It matches Supabase Auth's "Lowercase,
// uppercase letters, digits and symbols" setting: letters are A–Z and a–z, a symbol is a keyboard symbol
// (! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~), and Supabase refuses anything over
// 72 bytes. So the checklist never approves a password Supabase would refuse.
export const PASSWORD_MIN=8,PASSWORD_MAX_BYTES=72;
export const PASSWORD_MESSAGE=`Use at least ${PASSWORD_MIN} characters with an uppercase letter, a lowercase letter, a number and a symbol.`;
export const PASSWORD_CHECKS=[
 {label:`${PASSWORD_MIN}+ characters`,test:value=>value.length>=PASSWORD_MIN},
 {label:'Uppercase letter',test:value=>/[A-Z]/.test(value)},
 {label:'Lowercase letter',test:value=>/[a-z]/.test(value)},
 {label:'Number',test:value=>/[0-9]/.test(value)},
 {label:'Symbol',test:value=>/[!-\/:-@\[-`{-~]/.test(value)}
];
export const passwordMeetsRule=value=>typeof value==='string'&&new TextEncoder().encode(value).length<=PASSWORD_MAX_BYTES&&PASSWORD_CHECKS.every(check=>check.test(value));
