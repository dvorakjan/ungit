ungit
======

Forked from [FredrikNoren/ungit](https://github.com/FredrikNoren/ungit) and added functionality:
  * LDAP authentication
  * call git commands with ``sudo -u {logged in user name}``
  * list repos in given folder on homescreen

## Installation
```bashp
npm install -g forever 
npm install -g grunt 
npm install -g grunt-cli

git clone https://github.com/dvorakjan/ungit.git /opt/ungit
cd /opt/ungit
npm install
grunt

# SysVInit
ln -s /opt/ungit/bin/initScript.sh /etc/init.d/ungit
chmod +x /etc/init.d/ungit

# Systemd
cp /opt/ungit/bin/ungit.service /etc/systemd/system/ungit.service
systemctl daemon-reload
systemctl enable ungit
systemctl start ungit

# Ubuntu
update-rc.d ungit defaults

# CentOS
chkconfig --add ungit
```

## Configuration
Place ``ungitrc`` file to ``/etc/`` and use config properties from [FredrikNoren/ungit](https://github.com/FredrikNoren/ungit). These properties was added:
  * ``[false|array] ldap`` if authentication property is true, use this server config to auth user with given LDAP server. See https://github.com/vesse/passport-ldapauth for server config syntax
  * ``[bool] sudo`` use logged in user as sudo -u {user} before git commands
  * ``[string] sudoGroup`` use this value as sudo -g {group} before git commands (used only if sudo=true)
  * ``[string] homeReposPath`` path to folder whicih repos will be listed on homescreen
