// Terms of Use and Privacy Notice, served at /legal/terms and /legal/privacy.
//
// DRAFT: written for a small invite-only beta run from Malaysia. It is not legal advice. Have a lawyer review it
// before opening the service to the public. Set OPERATOR_NAME and CONTACT_EMAIL in the environment.
// Bump LEGAL_VERSION whenever the text changes in a way users must accept again.
export const LEGAL_VERSION = "2026-10-06-r3"; // YYYY-MM-DD-revision: shown date is the first 10 characters

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const operator = () => esc(process.env.OPERATOR_NAME || "the person who runs this app");
const email = () => {
  const e = process.env.CONTACT_EMAIL;
  return e ? `<a href="mailto:${esc(e)}">${esc(e)}</a>` : `<mark>[CONTACT_EMAIL is not set yet]</mark>`;
};
export const legalConfigured = () => !!process.env.CONTACT_EMAIL;

/* ------------------------------------------------------------------ TERMS ------------------------------------------------------------------ */
const TERMS = {
  en: () => `
<h2>1. About this service</h2>
<p>Song Explain (“the Service”) lets you save songs, read AI-written explanations of lyrics, read what other listeners say, keep private notes and, if you choose, share your own feelings about a song with other members. It is run by <b>${operator()}</b> (“we”, “us”). Contact: ${email()}.</p>
<p>The Service is a <b>private beta</b> for invited people. It may change, break or be shut down, and data may be lost. Keep your own copy of anything important (Account → Export my data).</p>

<h2>2. Who may use it</h2>
<p>You must be <b>18 or older</b>, have received a personal invite code from us, and use one account only. Do not share or sell your invite code. We may refuse or end access at any time, including if these Terms are broken.</p>

<h2>3. Your account</h2>
<p>Keep your password safe. There is no password recovery in the beta. You are responsible for what happens under your account; tell us straight away if you think it was misused.</p>

<h2>4. Your content</h2>
<ul>
<li>You own what you write. Your notes are private unless you tick “Share”.</li>
<li>When you share a feeling you give us a free, non-exclusive licence to store it and show it to other signed-in members, under your display name, until you make it private or delete it.</li>
<li>You promise you have the right to post it and that it follows section 5.</li>
<li>We may hide or remove content and suspend accounts to follow the law or protect members. You can make a shared post private or delete it at any time.</li>
</ul>

<h2>5. Rules for shared content</h2>
<p>Do not post anything that: is unlawful, threatening, harassing, hateful or defamatory; insults, or stirs up hatred on the basis of, race, religion or royalty, or is seditious or otherwise offensive in a way that breaks Malaysian law; is sexual, or involves minors in any sexual way; reveals other people’s personal information; is spam or advertising, or contains links; copies whole lyrics or other copyrighted material (quote at most a line or two, with credit); or infringes anyone’s rights.</p>

<h2>6. Lyrics, music and third-party content</h2>
<p>Lyrics, song titles, cover art and other music content belong to their owners; we claim none of it. To write explanations the Service looks up lyrics from third-party sources and keeps them privately in your account; they are never shown to other members. Lyric cards are for sharing a small excerpt with credit to the song. Listener comments and Wikipedia text belong to their authors; we show small samples, without names, and do not endorse them. If you are a rights holder and think something breaks your rights, see section 9.</p>

<h2>7. AI features</h2>
<p>Explanations are written by an AI model that you connect with your own API key. They are generated text, can be wrong, and are one interpretation — not facts about what an artist meant. To produce them the Service sends the song title, artist, lyrics text and related material to the AI provider you choose; that provider’s own terms and privacy policy apply and it bills you directly. You are responsible for your key and any charges. Use a key made for this purpose, with a spending limit, and remove it if you stop using the Service.</p>

<h2>8. Reports and moderation</h2>
<p>Use “report” on any shared post. Moderators may hide posts and remove accounts. We aim to respond within a reasonable time but cannot promise to review everything. You can also send bug reports and feedback from the app; only the person running the Service can read them.</p>

<h2>9. Copyright and takedown</h2>
<p>To report an infringement, email ${email()} with: the work concerned and a statement that you own it or act for the owner; where the material appears; your contact details; and a statement that you believe in good faith that the use is not authorised. We will review it promptly, may remove the material, and may suspend repeat offenders. If you think content was removed by mistake, tell us.</p>

<h2>10. Ending your use</h2>
<p>You can delete your account at any time (Account → Delete my account) and export your data first. We may suspend or end the Service or any account.</p>

<h2>11. No warranty; limit of liability</h2>
<p>The Service is a free beta provided “as is”. To the fullest extent the law allows, we give no warranties and are not liable for indirect or consequential loss, loss of data, or charges made by AI or other providers. Nothing here limits liability that the law does not allow us to limit.</p>

<h2>12. Changes and governing law</h2>
<p>We may update these Terms; for important changes we will ask you to accept the new version. These Terms are governed by the laws of Malaysia and the courts of Malaysia have jurisdiction, subject to any rights you have under mandatory law.</p>`,

  zh: () => `
<h2>1. 关于本服务</h2>
<p>Song Explain（“本服务”）可以让你保存歌曲、阅读 AI 撰写的歌词解读、查看其他听众的看法、记录私人笔记，并在你选择时与其他成员分享你对一首歌的感受。本服务由 <b>${operator()}</b>（“我们”）运营。联系方式：${email()}。</p>
<p>本服务目前是仅限受邀者的<b>内部测试</b>，可能会更改、出错或停止，数据也可能丢失。重要内容请自行备份（Account → Export my data）。</p>

<h2>2. 谁可以使用</h2>
<p>你必须<b>年满 18 岁</b>，持有我们发给你个人的邀请码，并且只使用一个账号。请勿转让或出售邀请码。我们可以随时拒绝或终止访问，包括你违反本条款时。</p>

<h2>3. 你的账号</h2>
<p>请保管好密码。测试期间没有找回密码功能。你要对账号下发生的事情负责；如果你认为账号被滥用，请立即告诉我们。</p>

<h2>4. 你的内容</h2>
<ul>
<li>你写的内容归你所有。除非你勾选 “Share”，笔记都是私有的。</li>
<li>当你分享一条感受，即表示你授予我们免费、非独占的许可，可以保存它并以你的昵称向其他已登录成员展示，直到你把它改为私有或删除。</li>
<li>你保证你有权发布，并且遵守第 5 条。</li>
<li>为遵守法律或保护成员，我们可以隐藏或删除内容、暂停账号。你可以随时将已分享的内容改为私有或删除。</li>
</ul>

<h2>5. 分享内容的规则</h2>
<p>不得发布以下内容：违法、威胁、骚扰、仇恨或诽谤的内容；侮辱或煽动针对种族、宗教或王室的仇恨，或触犯马来西亚法律的煽动性、冒犯性内容；色情内容，或以任何性方式涉及未成年人的内容；泄露他人个人信息；垃圾信息、广告或带链接的内容；复制整段歌词或其他受版权保护的内容（最多引用一两句并注明出处）；侵犯他人权利的内容。</p>

<h2>6. 歌词、音乐与第三方内容</h2>
<p>歌词、歌名、封面及其他音乐内容归其权利人所有，我们不主张任何权利。为了撰写解读，本服务会从第三方来源查找歌词，并私下保存在你的账号中，绝不会向其他成员展示。歌词卡用于分享一小段摘录并注明歌曲出处。听众评论和维基百科文字归其作者所有；我们只展示少量样本、不显示用户名，也不代表认同其观点。如果你是权利人并认为有内容侵犯了你的权利，请见第 9 条。</p>

<h2>7. AI 功能</h2>
<p>解读由你用自己的 API key 连接的 AI 模型撰写。它们是生成的文字，可能有错误，只是一种解读，不代表艺人的真实意图。为了生成解读，本服务会把歌名、歌手、歌词文字和相关资料发送给你选择的 AI 服务商；该服务商有自己的条款和隐私政策，并直接向你收费。你要对自己的 key 及任何费用负责。请使用专门为此创建、设有额度上限的 key，不再使用时请移除。</p>

<h2>8. 举报与管理</h2>
<p>对任何已分享的内容都可以使用 “report”。管理员可以隐藏内容、移除账号。我们会在合理时间内回应，但不保证审核每一条内容。你也可以在应用里发送问题报告和反馈，只有运营本服务的人能看到。</p>

<h2>9. 版权与下架</h2>
<p>如需举报侵权，请发邮件至 ${email()}，并写明：涉及的作品及你是权利人或其代理人的声明；侵权内容出现的位置；你的联系方式；以及你善意相信该使用未获授权的声明。我们会尽快审核，可能删除相关内容，并可能暂停屡犯者的账号。如果你认为内容被误删，请告诉我们。</p>

<h2>10. 停止使用</h2>
<p>你可以随时删除账号（Account → Delete my account），并可先导出你的数据。我们也可以暂停或终止本服务或任何账号。</p>

<h2>11. 不作保证；责任限制</h2>
<p>本服务是免费的测试版，按“现状”提供。在法律允许的最大范围内，我们不作任何保证，也不对间接或后果性损失、数据丢失，或 AI 及其他服务商收取的费用负责。本条款不限制法律不允许限制的责任。</p>

<h2>12. 变更与适用法律</h2>
<p>我们可能更新本条款；重要变更会请你接受新版本。本条款受马来西亚法律管辖，马来西亚法院有管辖权，但不影响你依强制性法律享有的权利。如中英文版本不一致，以英文版为准。</p>`,
};

/* ----------------------------------------------------------------- PRIVACY ----------------------------------------------------------------- */
const PRIVACY = {
  en: () => `
<p>This notice is given under the <b>Personal Data Protection Act 2010</b> (Malaysia). The data user is <b>${operator()}</b>, contact: ${email()}. This notice is provided in English, Bahasa Malaysia and Chinese; if they differ, the English version prevails.</p>

<h2>1. What we collect, and why</h2>
<ul>
<li><b>Account:</b> your email, your password (kept only as a salted hash), your display name (if you choose one) and when you accepted these documents — to create and secure your account.</li>
<li><b>Your content:</b> songs you save, lyrics (pasted by you or looked up for you), explanations, private notes and feelings you share — to provide the Service.</li>
<li><b>AI connection:</b> if you choose “Remember”, your API key (encrypted), model names and connection status. Keys you use “this session only” are never stored — to let you use AI.</li>
<li><b>Safety:</b> reports you file, and posts that were hidden — to keep the community safe.</li>
<li><b>Feedback:</b> if you send a bug report or feedback, the message, the page you were on and your browser type, linked to your account — to fix problems. Only the person running the Service can read it; it is kept until the issue is resolved or you delete your account.</li>
<li><b>Technical:</b> a login cookie; your IP address is used briefly in memory to limit abuse; our hosting provider may keep standard server logs. We use no analytics, advertising or tracking.</li>
</ul>
<p>Giving us this data is voluntary, but we cannot provide the Service without the account data.</p>

<h2>2. Who sees what</h2>
<ul>
<li>Only you see your account details, saved songs, lyrics, explanations and private notes.</li>
<li>A feeling you choose to share shows to signed-in members with your display name, mood, section, text and date — never your email.</li>
<li>Moderators can see reported or hidden posts together with the author’s email, and who used which invite code. They can also read any feedback you send.</li>
</ul>

<h2>3. Who we share data with</h2>
<ul>
<li><b>The AI provider you choose</b> (for example Anthropic, OpenAI, Google, DeepSeek, Alibaba, Groq, OpenRouter or a custom service) receives the song title, artist, lyrics text and related material for each request you make.</li>
<li><b>Music, lyrics and comment sources:</b> song titles and artists are sent to LRCLIB, NetEase Cloud Music, lyrics.ovh, Apple’s iTunes Search, Deezer, MusicBrainz, Wikipedia and, if you add a YouTube key, Google/YouTube, to find lyrics, covers and background. Your email and name are not sent.</li>
<li><b>Google Fonts:</b> page fonts are loaded from Google, which may receive your IP address and browser details.</li>
<li><b>Hosting:</b> ${esc(process.env.HOSTING_NOTE || "our hosting provider")}.</li>
<li>We may disclose data where the law requires it. We do not sell personal data.</li>
</ul>

<h2>4. Transfers outside Malaysia</h2>
<p>Hosting and AI providers may process data outside Malaysia. By using the Service, and the AI features in particular, you consent to this.</p>

<h2>5. Cookies and local storage</h2>
<p>One essential cookie keeps you signed in. Your browser also stores preferences (theme, language, selected model). There are no tracking or advertising cookies.</p>

<h2>6. Security</h2>
<p>Passwords are stored as salted hashes; saved API keys are encrypted; connections use HTTPS; access is restricted. No system is perfectly secure. If a breach is likely to cause significant harm, we will notify affected users and the Personal Data Protection Commissioner as the law requires.</p>

<h2>7. How long we keep it</h2>
<p>While your account exists. When you delete your account, your account and content are removed from the live database immediately; backups may keep copies for up to 30 days. Invite codes are stored only as hashes.</p>

<h2>8. Your rights</h2>
<p>You may access your data (Account → Export my data), correct it (edit your notes and display name), delete it (Account → Delete my account) and withdraw consent (delete your account, or remove saved API keys in AI settings). You can also contact us at ${email()}. You may complain to the Personal Data Protection Commissioner of Malaysia.</p>

<h2>9. Age</h2>
<p>The Service is for people aged 18 or older.</p>

<h2>10. Changes</h2>
<p>If we change this notice in an important way we will ask you to review it again.</p>`,

  ms: () => `
<p>Notis ini diberikan di bawah <b>Akta Perlindungan Data Peribadi 2010</b> (Malaysia). Pengguna data ialah <b>${operator()}</b>, hubungan: ${email()}. Notis ini disediakan dalam Bahasa Inggeris, Bahasa Malaysia dan Bahasa Cina; jika terdapat perbezaan, versi Bahasa Inggeris diutamakan.</p>

<h2>1. Apa yang kami kumpul dan mengapa</h2>
<ul>
<li><b>Akaun:</b> e-mel anda, kata laluan anda (disimpan hanya sebagai hash bergaram), nama paparan (jika anda memilih) dan masa anda menerima dokumen ini — untuk mencipta dan melindungi akaun anda.</li>
<li><b>Kandungan anda:</b> lagu yang anda simpan, lirik (ditampal oleh anda atau dicari untuk anda), penjelasan, nota peribadi dan perasaan yang anda kongsi — untuk menyediakan Perkhidmatan.</li>
<li><b>Sambungan AI:</b> jika anda memilih “Remember”, kunci API anda (disulitkan), nama model dan status sambungan. Kunci yang digunakan “untuk sesi ini sahaja” tidak pernah disimpan — supaya anda dapat menggunakan AI.</li>
<li><b>Keselamatan:</b> laporan yang anda hantar dan siaran yang disembunyikan — untuk memastikan komuniti selamat.</li>
<li><b>Maklum balas:</b> jika anda menghantar laporan pepijat atau maklum balas, mesej, halaman yang anda berada dan jenis pelayar anda, dipautkan kepada akaun anda — untuk membaiki masalah. Hanya orang yang mengendalikan Perkhidmatan boleh membacanya; ia disimpan sehingga isu diselesaikan atau anda memadam akaun anda.</li>
<li><b>Teknikal:</b> satu kuki log masuk; alamat IP anda digunakan seketika dalam memori untuk menghadkan penyalahgunaan; penyedia pengehosan kami mungkin menyimpan log pelayan biasa. Kami tidak menggunakan analitik, pengiklanan atau penjejakan.</li>
</ul>
<p>Pemberian data ini adalah secara sukarela, tetapi kami tidak dapat menyediakan Perkhidmatan tanpa data akaun.</p>

<h2>2. Siapa nampak apa</h2>
<ul>
<li>Hanya anda yang nampak butiran akaun, lagu yang disimpan, lirik, penjelasan dan nota peribadi anda.</li>
<li>Perasaan yang anda pilih untuk kongsi dipaparkan kepada ahli yang telah log masuk dengan nama paparan, mood, bahagian, teks dan tarikh anda — tidak pernah e-mel anda.</li>
<li>Moderator boleh melihat siaran yang dilaporkan atau disembunyikan bersama e-mel penulis, dan siapa yang menggunakan kod jemputan yang mana. Mereka juga boleh membaca sebarang maklum balas yang anda hantar.</li>
</ul>

<h2>3. Dengan siapa kami berkongsi data</h2>
<ul>
<li><b>Penyedia AI yang anda pilih</b> (contohnya Anthropic, OpenAI, Google, DeepSeek, Alibaba, Groq, OpenRouter atau perkhidmatan tersuai) menerima tajuk lagu, artis, teks lirik dan bahan berkaitan bagi setiap permintaan yang anda buat.</li>
<li><b>Sumber muzik, lirik dan komen:</b> tajuk lagu dan artis dihantar kepada LRCLIB, NetEase Cloud Music, lyrics.ovh, iTunes Search Apple, Deezer, MusicBrainz, Wikipedia dan, jika anda menambah kunci YouTube, Google/YouTube, untuk mencari lirik, sampul dan maklumat latar. E-mel dan nama anda tidak dihantar.</li>
<li><b>Google Fonts:</b> fon halaman dimuatkan daripada Google, yang mungkin menerima alamat IP dan butiran pelayar anda.</li>
<li><b>Pengehosan:</b> ${esc(process.env.HOSTING_NOTE || "penyedia pengehosan kami")}.</li>
<li>Kami boleh mendedahkan data jika dikehendaki oleh undang-undang. Kami tidak menjual data peribadi.</li>
</ul>

<h2>4. Pemindahan ke luar Malaysia</h2>
<p>Pengehosan dan penyedia AI mungkin memproses data di luar Malaysia. Dengan menggunakan Perkhidmatan ini, terutamanya ciri AI, anda bersetuju dengan perkara ini.</p>

<h2>5. Kuki dan storan tempatan</h2>
<p>Satu kuki penting mengekalkan log masuk anda. Pelayar anda juga menyimpan pilihan (tema, bahasa, model yang dipilih). Tiada kuki penjejakan atau pengiklanan.</p>

<h2>6. Keselamatan</h2>
<p>Kata laluan disimpan sebagai hash bergaram; kunci API yang disimpan disulitkan; sambungan menggunakan HTTPS; akses dihadkan. Tiada sistem yang selamat sepenuhnya. Jika pelanggaran data berkemungkinan menyebabkan kemudaratan ketara, kami akan memberitahu pengguna yang terjejas dan Pesuruhjaya Perlindungan Data Peribadi seperti yang dikehendaki undang-undang.</p>

<h2>7. Tempoh penyimpanan</h2>
<p>Selagi akaun anda wujud. Apabila anda memadam akaun, akaun dan kandungan anda dibuang daripada pangkalan data aktif serta-merta; sandaran mungkin menyimpan salinan sehingga 30 hari. Kod jemputan disimpan hanya sebagai hash.</p>

<h2>8. Hak anda</h2>
<p>Anda boleh mengakses data anda (Account → Export my data), membetulkannya (sunting nota dan nama paparan), memadamnya (Account → Delete my account) dan menarik balik persetujuan (padam akaun anda, atau buang kunci API yang disimpan dalam tetapan AI). Anda juga boleh menghubungi kami di ${email()}. Anda boleh membuat aduan kepada Pesuruhjaya Perlindungan Data Peribadi Malaysia.</p>

<h2>9. Umur</h2>
<p>Perkhidmatan ini untuk orang berumur 18 tahun ke atas.</p>

<h2>10. Perubahan</h2>
<p>Jika kami mengubah notis ini dengan cara yang penting, kami akan meminta anda menyemaknya semula.</p>`,

  zh: () => `
<p>本通知依据马来西亚《2010 年个人资料保护法》（PDPA）发出。资料使用者为 <b>${operator()}</b>，联系方式：${email()}。本通知提供英文、马来文和中文版本；如有不一致，以英文版为准。</p>

<h2>1. 我们收集什么，为什么</h2>
<ul>
<li><b>账号：</b>你的邮箱、密码（只以加盐哈希保存）、昵称（如果你设置了），以及你接受这些文件的时间 —— 用于创建和保护你的账号。</li>
<li><b>你的内容：</b>你保存的歌曲、歌词（你粘贴的或为你查找的）、解读、私人笔记和你分享的感受 —— 用于提供本服务。</li>
<li><b>AI 连接：</b>如果你选择 “Remember”，则保存你的 API key（已加密）、模型名称和连接状态。“仅本次使用”的 key 不会被保存 —— 用于让你使用 AI。</li>
<li><b>安全：</b>你提交的举报，以及被隐藏的内容 —— 用于维护社区安全。</li>
<li><b>反馈：</b>如果你发送问题报告或反馈，我们会保存信息内容、你所在的页面和浏览器类型，并与你的账号关联 —— 用于修复问题。只有运营本服务的人能看到；保存到问题解决或你删除账号为止。</li>
<li><b>技术信息：</b>一个登录 cookie；你的 IP 地址会在内存中短暂用于限制滥用；我们的托管服务商可能保留标准服务器日志。我们不使用统计分析、广告或追踪。</li>
</ul>
<p>提供这些资料是自愿的，但没有账号资料我们无法提供本服务。</p>

<h2>2. 谁能看到什么</h2>
<ul>
<li>只有你本人能看到你的账号信息、保存的歌曲、歌词、解读和私人笔记。</li>
<li>你选择分享的感受，会以你的昵称、心情、对应段落、文字和日期显示给已登录的成员，绝不会显示你的邮箱。</li>
<li>管理员可以看到被举报或被隐藏的内容及作者邮箱，以及谁使用了哪个邀请码。他们也能看到你发送的反馈。</li>
</ul>

<h2>3. 我们与谁共享资料</h2>
<ul>
<li><b>你选择的 AI 服务商</b>（例如 Anthropic、OpenAI、Google、DeepSeek、阿里、Groq、OpenRouter 或自定义服务）会在你每次请求时收到歌名、歌手、歌词文字和相关资料。</li>
<li><b>音乐、歌词和评论来源：</b>歌名和歌手会发送给 LRCLIB、网易云音乐、lyrics.ovh、Apple iTunes Search、Deezer、MusicBrainz、维基百科，以及（如果你添加了 YouTube key）Google/YouTube，用于查找歌词、封面和背景资料。不会发送你的邮箱和姓名。</li>
<li><b>Google Fonts：</b>页面字体从 Google 加载，Google 可能会收到你的 IP 地址和浏览器信息。</li>
<li><b>托管：</b>${esc(process.env.HOSTING_NOTE || "我们的托管服务商")}。</li>
<li>法律要求时我们可能披露资料。我们不出售个人资料。</li>
</ul>

<h2>4. 向马来西亚境外传输</h2>
<p>托管服务和 AI 服务商可能在马来西亚境外处理资料。使用本服务，特别是 AI 功能，即表示你同意这一点。</p>

<h2>5. Cookie 与本地存储</h2>
<p>一个必要的 cookie 用于保持登录。你的浏览器还会保存偏好设置（主题、语言、所选模型）。没有追踪或广告 cookie。</p>

<h2>6. 安全</h2>
<p>密码以加盐哈希保存；保存的 API key 已加密；连接使用 HTTPS；访问受到限制。没有任何系统是绝对安全的。如果资料泄露可能造成重大损害，我们会依法通知受影响的用户和个人资料保护专员。</p>

<h2>7. 保存多久</h2>
<p>只要你的账号存在。你删除账号后，账号和内容会立即从正在使用的数据库中删除；备份可能保留副本最多 30 天。邀请码只以哈希形式保存。</p>

<h2>8. 你的权利</h2>
<p>你可以查阅你的资料（Account → Export my data）、更正（编辑笔记和昵称）、删除（Account → Delete my account）以及撤回同意（删除账号，或在 AI 设置里移除已保存的 API key）。你也可以通过 ${email()} 联系我们。你可以向马来西亚个人资料保护专员投诉。</p>

<h2>9. 年龄</h2>
<p>本服务面向年满 18 岁的人。</p>

<h2>10. 变更</h2>
<p>如果我们对本通知作出重要变更，会请你重新查看。</p>`,
};

const LANG_LABEL = { en: "English", ms: "Bahasa Malaysia", zh: "中文" };
const TITLES = {
  terms: { en: "Terms of Use", zh: "使用条款" },
  privacy: { en: "Privacy Notice", ms: "Notis Privasi", zh: "隐私通知" },
};

// Returns the full HTML page for "terms" or "privacy", or null if unknown.
export function legalPage(name) {
  const docs = name === "terms" ? TERMS : name === "privacy" ? PRIVACY : null;
  if (!docs) return null;
  const langs = Object.keys(docs);
  const nav = langs.map((l) => `<a href="#${l}">${LANG_LABEL[l]}</a>`).join(" · ");
  const body = langs
    .map((l) => `<section id="${l}" lang="${l === "zh" ? "zh-Hans" : l}"><h1>${TITLES[name][l]}</h1><p class="meta">Song Explain · beta · ${l === "zh" ? "最后更新" : l === "ms" ? "Kemas kini terakhir" : "Last updated"}: ${LEGAL_VERSION.slice(0, 10)}</p>${docs[l]()}</section>`)
    .join("\n");
  const title = TITLES[name].en;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Song Explain.</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400&family=Inter:wght@400;500&family=Noto+Sans+SC:wght@400;700&family=Space+Grotesk:wght@700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/legal.css">
</head><body>
<!-- DRAFT: written for a small invite-only beta in Malaysia. Not legal advice; have a lawyer review before a public launch. -->
<header><a class="word" href="/">← Song Explain.</a>
<nav aria-label="Language">${nav}</nav>
<nav class="other">${name === "terms" ? '<a href="/legal/privacy">Privacy Notice</a>' : '<a href="/legal/terms">Terms of Use</a>'}</nav></header>
<main>${body}</main>
</body></html>`;
}
